import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  McpRpcReqPayload,
  McpRpcResPayload,
  MuxFrame,
  SessionReadyPayload,
  SpawnSessionPayload,
} from "@agent-remote/protocol";
import { buildEd25519AuthHeader } from "./ed25519-auth.js";

/**
 * Normalizes user-entered Tailnet / LAN / VPN / local node URLs into a valid WebSocket `/v1/ws` endpoint.
 * Examples:
 * - `https://box.tail.ts.net` -> `wss://box.tail.ts.net/v1/ws`
 * - `https://box.tail.ts.net/healthz` -> `wss://box.tail.ts.net/v1/ws`
 * - `wss://box.tail.ts.net/` -> `wss://box.tail.ts.net/v1/ws`
 * - `box.tail.ts.net` -> `wss://box.tail.ts.net/v1/ws`
 * - `127.0.0.1:19420` -> `ws://127.0.0.1:19420/v1/ws`
 * - `192.168.1.50:19420` -> `ws://192.168.1.50:19420/v1/ws`
 * - `10.8.0.2:19420` -> `ws://10.8.0.2:19420/v1/ws`
 */
export function normalizeTailnetEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(candidate);
    // Direct IP:port targets on LAN / OpenVPN / WireGuard (e.g. 192.168.1.50:19420,
    // 10.8.0.2:19420, [fd00::1]:19420) speak plain HTTP/WS unless port 443 is used.
    const isDirectIpWithPort =
      /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(?!443(?:\/|$))\d+(?:\/|$)/.test(candidate);
    candidate = `${isLoopback || isDirectIpWithPort ? "ws" : "wss"}://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    } else if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (cleanPath === "" || cleanPath === "/healthz") {
      parsed.pathname = "/v1/ws";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export interface TailnetClientOptions {
  hostId: string;
  endpoint: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  /** PKCS#8 or unencrypted OpenSSH Ed25519 private key PEM for `pubkey` auth mode. */
  privateKeyPem?: string;
  autoReconnect?: boolean;
}

export interface NodeHelloAck {
  nodeVersion: string;
  hostname: string;
  os: string;
  arch: string;
  peerUser?: string;
}

export interface NodeProbeResult {
  hostname: string;
  os: string;
  arch: string;
  activeSessions: number;
  maxSessions: number;
  agents: Array<{
    agent: string;
    binary: string;
    installed: boolean;
    binaryPath?: string;
    version?: string;
  }>;
}

export interface RemoteSessionChannel extends EventEmitter {
  readonly sessionId: string;
  readonly channel: number;
  readonly workdir: string;
  readonly mcpEndpointUrl?: string;
  readonly mcpBearerToken?: string;
  writeStdin(data: string): void;
  kill(): void;
  setMcpHandler(handler: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>): void;
}

class ManagedChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId: string;
  channel: number;
  workdir: string;
  mcpEndpointUrl?: string;
  mcpBearerToken?: string;
  lastAckSeq = 0;

  private readonly sendFrame: (frame: MuxFrame) => void;
  private readonly sendReliableFrame: (frame: MuxFrame) => Promise<void>;
  private readonly onKill: (ch: ManagedChannel) => void;
  private mcpHandler?: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>;

  constructor(
    ready: SessionReadyPayload,
    sendFrame: (frame: MuxFrame) => void,
    sendReliableFrame: (frame: MuxFrame) => Promise<void>,
    onKill: (ch: ManagedChannel) => void,
  ) {
    super();
    this.sessionId = ready.sessionId;
    this.channel = ready.channel;
    this.workdir = ready.workdir;
    this.mcpEndpointUrl = ready.mcpEndpointUrl;
    this.mcpBearerToken = ready.mcpBearerToken;
    this.sendFrame = sendFrame;
    this.sendReliableFrame = sendReliableFrame;
    this.onKill = onKill;
  }

  writeStdin(data: string): void {
    this.sendFrame({
      ch: this.channel,
      type: "session_stdin",
      payload: { data },
    });
  }

  kill(): void {
    this.onKill(this);
    try {
      this.sendFrame({
        ch: this.channel,
        type: "session_kill",
      });
    } catch {
      // WSS already disconnected; local tracking has been cleaned up
    }
  }

  setMcpHandler(handler: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>): void {
    this.mcpHandler = handler;
  }

  async handleMcpReq(req: McpRpcReqPayload): Promise<void> {
    if (!this.mcpHandler) {
      await this.sendReliableFrame({
        ch: this.channel,
        type: "mcp_rpc_res",
        payload: {
          rpcId: req.rpcId,
          status: 503,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "No local MCP handler attached" }),
        } satisfies McpRpcResPayload,
      }).catch(() => {});
      return;
    }
    try {
      const res = await this.mcpHandler(req);
      await this.sendReliableFrame({
        ch: this.channel,
        type: "mcp_rpc_res",
        payload: res,
      }).catch(() => {});
    } catch (err) {
      await this.sendReliableFrame({
        ch: this.channel,
        type: "mcp_rpc_res",
        payload: {
          rpcId: req.rpcId,
          status: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: (err as Error).message }),
        } satisfies McpRpcResPayload,
      }).catch(() => {});
    }
  }
}

/**
 * Multiplexed WebSocket transport client connecting the Local Hub to a Go `agent-remote-node`
 * over Tailscale Tailnet (or local loopback during development).
 */
export class TailnetDirectClient extends EventEmitter {
  readonly hostId: string;
  readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly privateKeyPem?: string;
  private readonly autoReconnect: boolean;

  private ws?: WebSocket;
  private connected = false;
  private closedByUser = false;
  private helloAck?: NodeHelloAck;
  private lastRttMs?: number;
  private connectPromise?: Promise<NodeHelloAck>;
  private reconnectTimer?: NodeJS.Timeout;

  private readonly pending = new Map<
    string,
    { resolve: (f: MuxFrame) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly channelsBySession = new Map<string, ManagedChannel>();
  private readonly channelsById = new Map<number, ManagedChannel>();

  constructor(options: TailnetClientOptions) {
    super();
    this.hostId = options.hostId;
    this.endpoint = normalizeTailnetEndpoint(options.endpoint);
    this.autoReconnect = options.autoReconnect ?? true;
    this.headers = { ...(options.headers ?? {}) };
    this.privateKeyPem = options.privateKeyPem?.trim() || undefined;
    if (!this.privateKeyPem && options.bearerToken) {
      this.headers.Authorization = `Bearer ${options.bearerToken}`;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatus() {
    return {
      hostId: this.hostId,
      endpoint: this.endpoint,
      connected: this.connected,
      rttMs: this.lastRttMs,
      node: this.helloAck,
      activeSessions: this.channelsBySession.size,
    };
  }

  async connect(timeoutMs = 12_000): Promise<NodeHelloAck> {
    if (this.connected && this.helloAck) {
      return this.helloAck;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    this.closedByUser = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const promise = new Promise<NodeHelloAck>((resolve, reject) => {
      if (!this.endpoint) {
        reject(new Error("Remote endpoint URL is empty"));
        return;
      }

      let ws: WebSocket;
      try {
        // Compute fresh headers per connection attempt so Ed25519 pubkey auth
        // uses a fresh timestamp & unique nonce on every reconnect.
        const connectHeaders: Record<string, string> = { ...this.headers };
        if (this.privateKeyPem) {
          const parsedUrl = new URL(this.endpoint);
          connectHeaders.Authorization = buildEd25519AuthHeader(
            this.privateKeyPem,
            "GET",
            parsedUrl.pathname || "/v1/ws",
          );
        }
        ws = new WebSocket(this.endpoint, {
          headers: connectHeaders,
          handshakeTimeout: timeoutMs,
        });
      } catch (err) {
        reject(new Error(`Invalid WebSocket endpoint "${this.endpoint}": ${(err as Error).message}`));
        return;
      }
      this.ws = ws;

      let settled = false;
      const connectTimer = setTimeout(() => {
        if (!settled) {
          fail(new Error(`Timed out after ${timeoutMs}ms connecting to ${this.endpoint}`));
          try {
            ws.terminate();
          } catch {
            // ignore terminate error
          }
        }
      }, timeoutMs);
      connectTimer.unref?.();

      const clearTimer = () => clearTimeout(connectTimer);

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimer();
          reject(err);
        }
      };

      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 512) body += chunk;
        });
        res.on("end", () => {
          const detail = body.trim() || res.statusMessage || "WebSocket upgrade rejected";
          fail(new Error(`HTTP ${res.statusCode ?? 0} from ${this.endpoint}: ${detail}`));
        });
        res.on("error", () => {
          fail(new Error(`HTTP ${res.statusCode ?? 0} from ${this.endpoint}: ${res.statusMessage || "WebSocket upgrade rejected"}`));
        });
      });

      ws.on("error", (err) => fail(err));

      ws.on("message", (raw) => {
        let frame: MuxFrame;
        try {
          frame = JSON.parse(raw.toString("utf8")) as MuxFrame;
        } catch {
          return;
        }

        if (frame.type === "hello_ack" && !settled) {
          settled = true;
          clearTimer();
          this.connected = true;
          this.helloAck = frame.payload as NodeHelloAck;
          this.emit("connected", this.helloAck);
          // Re-attach surviving remote sessions after reconnect
          void this.resumeAllSessions();
          resolve(this.helloAck);
          return;
        }

        this.handleIncomingFrame(frame);
      });

      ws.on("close", (code, reasonBuf) => {
        clearTimer();
        const wasConnected = this.connected;
        this.connected = false;
        this.rejectPending(new Error("Tailnet WSS connection closed"));
        if (wasConnected) {
          this.emit("disconnected");
        } else {
          const reason = reasonBuf?.toString("utf8").trim();
          fail(
            new Error(
              reason
                ? `WebSocket closed before hello_ack (code ${code}: ${reason})`
                : `WebSocket closed before hello_ack (code ${code})`,
            ),
          );
        }
        if (wasConnected && this.autoReconnect && !this.closedByUser) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.closedByUser && !this.connected) {
              void this.connect().catch(() => {});
            }
          }, 2000);
          this.reconnectTimer.unref();
        }
      });
    });

    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = undefined;
      }
    }
  }

  close(): void {
    this.closedByUser = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectPending(new Error("Client closed"));
    this.channelsBySession.clear();
    this.channelsById.clear();
    if (this.ws) {
      const sock = this.ws;
      this.ws = undefined;
      try {
        if (sock.readyState === WebSocket.OPEN) {
          sock.close();
          // Ensure TLS/TCP socket cannot pin Node/Electron open during Windows exit
          // while giving any queued session_kill frame a brief window to flush.
          (sock as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
          setTimeout(() => {
            try {
              sock.terminate();
            } catch {
              // ignore
            }
          }, 150).unref?.();
        } else {
          sock.terminate();
        }
      } catch {
        // ignore close errors
      }
    }
  }

  async ping(): Promise<number> {
    const start = Date.now();
    await this.requestControl({ ch: 0, type: "ping" });
    this.lastRttMs = Date.now() - start;
    return this.lastRttMs;
  }

  async probe(): Promise<NodeProbeResult> {
    const frame = await this.requestControl({ ch: 0, type: "probe_req" });
    return frame.payload as NodeProbeResult;
  }

  async discoverCatalogRaw(agent: string, binary?: string): Promise<{ rawOutput: string; error?: string }> {
    const frame = await this.requestControl(
      {
        ch: 0,
        type: "catalog_req",
        payload: { agent, binary },
      },
      25_000,
    );
    return frame.payload as { rawOutput: string; error?: string };
  }

  async fetchQuota(
    agent: string,
    binary?: string,
  ): Promise<{
    agent: string;
    available: boolean;
    source: "oauth-api" | "app-server-rpc" | "provider-balance" | "cli-probe" | "unavailable";
    planTier?: string;
    windows: Array<{
      label: string;
      usedPercent?: number;
      remainingPercent?: number;
      remainingAmount?: string;
      resetsAt?: string;
    }>;
    note?: string;
  }> {
    const frame = await this.requestControl(
      {
        ch: 0,
        type: "quota_req",
        payload: { agent, binary },
      },
      15_000,
    );
    return frame.payload as {
      agent: string;
      available: boolean;
      source: "oauth-api" | "app-server-rpc" | "provider-balance" | "cli-probe" | "unavailable";
      planTier?: string;
      windows: Array<{
        label: string;
        usedPercent?: number;
        remainingPercent?: number;
        remainingAmount?: string;
        resetsAt?: string;
      }>;
      note?: string;
    };
  }

  async spawnSession(spec: SpawnSessionPayload): Promise<RemoteSessionChannel> {
    const frame = await this.requestControl({
      ch: 0,
      type: "spawn_session",
      payload: spec,
    });
    const ready = frame.payload as SessionReadyPayload;
    const ch = new ManagedChannel(
      ready,
      (f) => this.sendRaw(f),
      (f) => this.sendReliable(f),
      (killed) => {
        this.channelsBySession.delete(killed.sessionId);
        this.channelsById.delete(killed.channel);
      },
    );
    this.channelsBySession.set(ready.sessionId, ch);
    this.channelsById.set(ready.channel, ch);
    return ch;
  }

  private async sendReliable(frame: MuxFrame, waitMs = 12_000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendRaw(frame);
      return;
    }
    if (this.closedByUser) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("connected", onReconnect);
        reject(new Error("Timed out waiting for Tailnet WSS reconnect"));
      }, waitMs);
      timer.unref?.();
      const onReconnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("connected", onReconnect);
    });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendRaw(frame);
    }
  }

  private async resumeAllSessions(): Promise<void> {
    for (const ch of this.channelsBySession.values()) {
      try {
        const frame = await this.requestControl({
          ch: 0,
          type: "session_resume",
          payload: { sessionId: ch.sessionId, lastAckSeq: ch.lastAckSeq },
        });
        const ready = frame.payload as SessionReadyPayload;
        this.channelsById.delete(ch.channel);
        ch.channel = ready.channel;
        this.channelsById.set(ch.channel, ch);
      } catch {
        ch.emit("exit", { sessionId: ch.sessionId, exitCode: -1, error: "remote session lost" });
        this.channelsBySession.delete(ch.sessionId);
        this.channelsById.delete(ch.channel);
      }
    }
  }

  private requestControl(frame: Omit<MuxFrame, "id">, timeoutMs = 15_000): Promise<MuxFrame> {
    const id = crypto.randomUUID();
    return new Promise<MuxFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Control request "${frame.type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ ...frame, id });
    });
  }

  private sendRaw(frame: MuxFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Tailnet WSS is not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private handleIncomingFrame(frame: MuxFrame): void {
    if (frame.id && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.type === "error") {
        const payload = frame.payload as { code?: string; message?: string } | undefined;
        entry.reject(new Error(payload?.message ?? payload?.code ?? "remote node error"));
      } else {
        entry.resolve(frame);
      }
      return;
    }

    if (frame.ch > 0) {
      const ch = this.channelsById.get(frame.ch);
      if (!ch) return;
      if (typeof frame.seq === "number" && frame.seq > ch.lastAckSeq) {
        ch.lastAckSeq = frame.seq;
      }

      switch (frame.type) {
        case "session_stdout":
          ch.emit("stdout", (frame.payload as { data: string }).data);
          break;
        case "session_stderr":
          ch.emit("stderr", (frame.payload as { data: string }).data);
          break;
        case "mcp_rpc_req":
          void ch.handleMcpReq(frame.payload as McpRpcReqPayload);
          break;
        case "session_exit":
          ch.emit("exit", frame.payload);
          this.channelsBySession.delete(ch.sessionId);
          this.channelsById.delete(ch.channel);
          break;
        default:
          break;
      }
    }
  }

  private rejectPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
