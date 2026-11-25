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

export interface TailnetClientOptions {
  hostId: string;
  endpoint: string;
  headers?: Record<string, string>;
  bearerToken?: string;
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
  private mcpHandler?: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>;

  constructor(
    ready: SessionReadyPayload,
    sendFrame: (frame: MuxFrame) => void,
  ) {
    super();
    this.sessionId = ready.sessionId;
    this.channel = ready.channel;
    this.workdir = ready.workdir;
    this.mcpEndpointUrl = ready.mcpEndpointUrl;
    this.mcpBearerToken = ready.mcpBearerToken;
    this.sendFrame = sendFrame;
  }

  writeStdin(data: string): void {
    this.sendFrame({
      ch: this.channel,
      type: "session_stdin",
      payload: { data },
    });
  }

  kill(): void {
    this.sendFrame({
      ch: this.channel,
      type: "session_kill",
    });
  }

  setMcpHandler(handler: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>): void {
    this.mcpHandler = handler;
  }

  async handleMcpReq(req: McpRpcReqPayload): Promise<void> {
    if (!this.mcpHandler) {
      this.sendFrame({
        ch: this.channel,
        type: "mcp_rpc_res",
        payload: {
          rpcId: req.rpcId,
          status: 503,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "No local MCP handler attached" }),
        } satisfies McpRpcResPayload,
      });
      return;
    }
    try {
      const res = await this.mcpHandler(req);
      this.sendFrame({
        ch: this.channel,
        type: "mcp_rpc_res",
        payload: res,
      });
    } catch (err) {
      this.sendFrame({
        ch: this.channel,
        type: "mcp_rpc_res",
        payload: {
          rpcId: req.rpcId,
          status: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: (err as Error).message }),
        } satisfies McpRpcResPayload,
      });
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
  private readonly autoReconnect: boolean;

  private ws?: WebSocket;
  private connected = false;
  private closedByUser = false;
  private helloAck?: NodeHelloAck;
  private lastRttMs?: number;

  private readonly pending = new Map<
    string,
    { resolve: (f: MuxFrame) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly channelsBySession = new Map<string, ManagedChannel>();
  private readonly channelsById = new Map<number, ManagedChannel>();

  constructor(options: TailnetClientOptions) {
    super();
    this.hostId = options.hostId;
    this.endpoint = options.endpoint;
    this.autoReconnect = options.autoReconnect ?? true;
    this.headers = { ...(options.headers ?? {}) };
    if (options.bearerToken) {
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

  async connect(): Promise<NodeHelloAck> {
    this.closedByUser = false;
    return await new Promise<NodeHelloAck>((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, { headers: this.headers });
      this.ws = ws;

      let settled = false;
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

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

      ws.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.rejectPending(new Error("Tailnet WSS connection closed"));
        if (wasConnected) {
          this.emit("disconnected");
        } else {
          fail(new Error("WebSocket closed before hello_ack"));
        }
        if (this.autoReconnect && !this.closedByUser) {
          setTimeout(() => {
            if (!this.closedByUser && !this.connected) {
              void this.connect().catch(() => {});
            }
          }, 2000).unref();
        }
      });
    });
  }

  close(): void {
    this.closedByUser = true;
    this.connected = false;
    this.rejectPending(new Error("Client closed"));
    this.ws?.close();
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
    const ch = new ManagedChannel(ready, (f) => this.sendRaw(f));
    this.channelsBySession.set(ready.sessionId, ch);
    this.channelsById.set(ready.channel, ch);
    return ch;
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
