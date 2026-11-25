import { EventEmitter } from "node:events";
import {
  parseAgySessionNewCatalog,
  type AgySessionNewResult,
  type CatalogSnapshot,
  type ThinkingEffort,
} from "@agent-remote/protocol";
import type { LocalToolEngine } from "@agent-remote/tool-plane";
import type { RemoteSessionChannel } from "@agent-remote/transport";

interface JsonRpcMsg {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpClientSessionOptions {
  channel: RemoteSessionChannel;
  toolEngine: LocalToolEngine;
  sessionId: string;
  /** When true, remote built-in FS/Shell permission requests are auto-rejected with guidance to use local MCP tools. */
  blockRemoteBuiltins?: boolean;
}

/**
 * Reusable ACP v1 JSON-RPC 2.0 session controller that drives remote ACP-compatible agents
 * (Antigravity `agy acp`, OpenCode `opencode acp`, Gemini `gemini --acp`, Kiro `kiro-cli acp`)
 * over a multiplexed Tailnet WSS channel or local stdio channel.
 */
export class AcpRemoteSession extends EventEmitter {
  private readonly channel: RemoteSessionChannel;
  private readonly toolEngine: LocalToolEngine;
  private readonly localSessionId: string;
  private readonly blockRemoteBuiltins: boolean;

  private nextId = 1;
  private stdoutBuf = "";
  private remoteSessionId?: string;
  private readonly pending = new Map<
    number,
    { resolve: (res: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(options: AcpClientSessionOptions) {
    super();
    this.channel = options.channel;
    this.toolEngine = options.toolEngine;
    this.localSessionId = options.sessionId;
    this.blockRemoteBuiltins = options.blockRemoteBuiltins ?? true;

    this.channel.on("stdout", (chunk: string) => this.onStdout(chunk));
    this.channel.on("stderr", (chunk: string) => this.emit("stderr", chunk));
    this.channel.on("exit", (info: unknown) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Remote ACP process exited"));
      }
      this.pending.clear();
      this.emit("exit", info);
    });
  }

  getRemoteSessionId(): string | undefined {
    return this.remoteSessionId;
  }

  async initialize(): Promise<Record<string, unknown>> {
    return (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "agent-remote", version: "0.1.0" },
    })) as Record<string, unknown>;
  }

  async startSession(options?: {
    systemPromptAppend?: string;
    extraMcpServers?: Array<Record<string, unknown>>;
  }): Promise<AgySessionNewResult> {
    const mcpServers: Array<Record<string, unknown>> = [...(options?.extraMcpServers ?? [])];
    if (this.channel.mcpEndpointUrl && this.channel.mcpBearerToken) {
      mcpServers.push({
        type: "http",
        name: "agent_remote_local",
        url: this.channel.mcpEndpointUrl,
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${this.channel.mcpBearerToken}`,
          },
        ],
      });
    }

    const params: Record<string, unknown> = {
      cwd: this.channel.workdir,
      mcpServers,
    };
    if (options?.systemPromptAppend) {
      params._meta = {
        antigravity: {
          systemPrompt: { append: options.systemPromptAppend },
        },
      };
    }

    const res = (await this.request("session/new", params, 30_000)) as AgySessionNewResult;
    this.remoteSessionId = res.sessionId;
    return res;
  }

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    if (!this.remoteSessionId) throw new Error("ACP session not initialized");
    return await this.request("session/set_config_option", {
      sessionId: this.remoteSessionId,
      configId,
      value,
    });
  }

  async setModelAndEffort(model?: string, effort?: ThinkingEffort): Promise<void> {
    if (model) {
      await this.setConfigOption("model", model);
    }
    if (effort) {
      await this.setConfigOption("thought_level", effort);
    }
  }

  async prompt(text: string): Promise<unknown> {
    if (!this.remoteSessionId) throw new Error("ACP session not initialized");
    return await this.request(
      "session/prompt",
      {
        sessionId: this.remoteSessionId,
        prompt: [{ type: "text", text }],
      },
      600_000,
    );
  }

  cancel(): void {
    if (!this.remoteSessionId) return;
    this.notify("session/cancel", { sessionId: this.remoteSessionId });
  }

  extractCatalogSnapshot(
    hostId: string,
    profileId: string,
    agent: "antigravity" | "opencode",
    sessionNewRes: AgySessionNewResult,
  ): CatalogSnapshot {
    const parsed = parseAgySessionNewCatalog(sessionNewRes);
    return {
      hostId,
      profileId,
      agent,
      tierName: parsed.tierName,
      currentModelId: parsed.currentModelId,
      models: parsed.models,
      extraConfigOptions: parsed.extraConfigOptions,
      fetchedAt: new Date().toISOString(),
    };
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 25_000,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: JsonRpcMsg): void {
    this.channel.writeStdin(JSON.stringify(msg) + "\n");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcMsg): void {
    // 1. Response to our outgoing request
    if (msg.id !== undefined && !msg.method) {
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 2. Incoming server-to-client RPC request (fs/*, terminal/*, session/request_permission)
    if (msg.id !== undefined && msg.method) {
      void this.handleServerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }

    // 3. Incoming server notification (session/update)
    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params ?? {});
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = (params.update ?? params) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? update.type ?? "");

    if (kind === "agent_message_chunk") {
      const content = update.content as { text?: string } | undefined;
      if (content?.text) {
        this.emit("event", {
          type: "text_delta",
          sessionId: this.localSessionId,
          text: content.text,
        });
      }
    } else if (kind === "agent_thought_chunk") {
      const content = update.content as { text?: string } | undefined;
      if (content?.text) {
        this.emit("event", {
          type: "thought_delta",
          sessionId: this.localSessionId,
          text: content.text,
        });
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      this.emit("raw_tool_update", update);
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (method === "fs/read_text_file") {
        const res = await this.toolEngine.executeTool(
          "read_file",
          {
            path: String(params.path ?? ""),
            start_line: params.line,
            end_line:
              params.line && params.limit
                ? Number(params.line) + Number(params.limit) - 1
                : undefined,
          },
          { sessionId: this.localSessionId },
        );
        if (!res.ok) {
          this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: res.content } });
          return;
        }
        this.send({ jsonrpc: "2.0", id, result: { content: res.content } });
        return;
      }

      if (method === "fs/write_text_file") {
        const res = await this.toolEngine.executeTool(
          "write_file",
          { path: String(params.path ?? ""), content: String(params.content ?? "") },
          { sessionId: this.localSessionId },
        );
        if (!res.ok) {
          this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: res.content } });
          return;
        }
        this.send({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "session/request_permission") {
        const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
        const title = String(toolCall.title ?? toolCall.name ?? "");
        const options = (params.options ?? []) as Array<{ optionId: string; kind?: string }>;
        const isLocalMcp = title.includes("agent_remote_local") || title.includes("dispatch_subagent");

        if (isLocalMcp || !this.blockRemoteBuiltins) {
          const allowOpt =
            options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ??
            options[0];
          this.send({
            jsonrpc: "2.0",
            id,
            result: { outcome: { outcome: "selected", optionId: allowOpt?.optionId ?? "allow" } },
          });
          return;
        }

        // Reject remote built-in tool execution on remote host; local tools run via agent_remote_local MCP
        const rejectOpt = options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
        this.send({
          jsonrpc: "2.0",
          id,
          result: {
            outcome: rejectOpt
              ? { outcome: "selected", optionId: rejectOpt.optionId }
              : { outcome: "cancelled" },
          },
        });
        return;
      }

      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported client RPC: ${method}` },
      });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }
}
