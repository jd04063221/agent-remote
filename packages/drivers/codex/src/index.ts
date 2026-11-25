import { EventEmitter } from "node:events";
import os from "node:os";
import {
  THINKING_EFFORTS,
  type ModelCatalogEntry,
  type SpawnSessionPayload,
  type SubagentBlueprint,
  type ThinkingEffort,
} from "@agent-remote/protocol";
import type { LocalToolEngine } from "@agent-remote/tool-plane";
import type { RemoteSessionChannel } from "@agent-remote/transport";

export interface CodexSubagentSpec {
  blueprint: SubagentBlueprint;
  model?: string;
  effort?: ThinkingEffort;
}

export interface CodexLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  model?: string;
  effort?: ThinkingEffort;
  localWorkspaceRoot: string;
  quotaSaverPrompt?: string;
  nativeSubagents?: CodexSubagentSpec[];
}

export function compileCodexSubagentToml(spec: CodexSubagentSpec): string {
  const lines = [
    `name = ${JSON.stringify(spec.blueprint.name)}`,
    `description = ${JSON.stringify(spec.blueprint.description)}`,
  ];
  if (spec.model) lines.push(`model = ${JSON.stringify(spec.model)}`);
  if (spec.effort) lines.push(`model_reasoning_effort = ${JSON.stringify(spec.effort)}`);
  if (spec.blueprint.systemPrompt) {
    lines.push(`developer_instructions = ${JSON.stringify(spec.blueprint.systemPrompt)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Builds the `codex app-server` launch specification:
 * - Launches inside remote empty sandbox (`--sandbox read-only` / approval-enforced)
 * - Injects reverse MCP-over-WSS config via `-c` overrides (zero pollution of remote ~/.codex/config.toml)
 * - Materializes Track 1 subagent TOML files cleanly
 */
export function buildCodexSpawnSpec(options: CodexLaunchOptions): {
  spawn: SpawnSessionPayload;
  developerInstructions: string;
} {
  const ephemeralFiles: Record<string, string> = {};
  for (const sub of options.nativeSubagents ?? []) {
    ephemeralFiles[`codex-agents/${sub.blueprint.name}.toml`] = compileCodexSubagentToml(sub);
  }

  const developerInstructions = [
    "[agent-remote: Split-Plane Codex Environment]",
    `The user's code and shell are on their LOCAL machine (${os.platform()} ${os.arch()}) at: ${options.localWorkspaceRoot}.`,
    "Remote server execution is locked down in an empty read-only directory.",
    "NEVER invoke built-in server shell or apply_patch tools; ALWAYS use the provided dynamic/local tools (`read_file`, `edit_file`, `write_file`, `delete_file`, `list_dir`, `glob`, `grep`, `run_command`).",
    options.quotaSaverPrompt ? `\n${options.quotaSaverPrompt}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  const args: string[] = [
    "app-server",
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'approval_policy="untrusted"',
    "-c",
    'mcp_servers.agent_remote_local.url="{{MCP_URL}}"',
    "-c",
    'mcp_servers.agent_remote_local.bearer_token_env_var="AGENT_REMOTE_MCP_TOKEN"',
  ];

  if (options.model) args.push("-c", `model=${JSON.stringify(options.model)}`);
  if (options.effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  }

  return {
    spawn: {
      sessionId: options.sessionId,
      agent: "codex",
      command: options.remoteBin ?? "codex",
      args,
      env: {},
      ephemeralFiles,
      enableMcpBridge: true,
    },
    developerInstructions,
  };
}

export interface CodexModelListResponse {
  models?: Array<{
    model: string;
    name?: string;
    hidden?: boolean;
    inputModalities?: string[];
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: string[];
  }>;
}

export function parseCodexModelList(res: CodexModelListResponse): ModelCatalogEntry[] {
  return (res.models ?? [])
    .filter((m) => !m.hidden)
    .map((m) => {
      const supported = (m.supportedReasoningEfforts ?? []).filter((e): e is ThinkingEffort =>
        (THINKING_EFFORTS as readonly string[]).includes(e),
      );
      const def =
        m.defaultReasoningEffort &&
        (THINKING_EFFORTS as readonly string[]).includes(m.defaultReasoningEffort)
          ? (m.defaultReasoningEffort as ThinkingEffort)
          : supported[0];
      return {
        id: m.model,
        displayName: m.name || m.model,
        source: "live-rpc" as const,
        capabilities: {
          supportsThinking: supported.length > 0,
          supportedEfforts: supported,
          defaultEffort: def,
        },
      };
    });
}

interface JsonRpcMsg {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * JSON-RPC controller for `codex app-server`:
 * - Queries live `model/list` (with exact `supportedReasoningEfforts`)
 * - Registers LocalToolEngine tools via `dynamicTools` (`item/tool/call` over stdio)
 * - Strategy C2 Approval Interceptor: rejects any leaked remote `commandExecution` / `fileChange`
 *   approval requests with explicit steer feedback to use the local tools instead.
 */
export class CodexAppServerSession extends EventEmitter {
  private readonly channel: RemoteSessionChannel;
  private readonly toolEngine: LocalToolEngine;
  private readonly localSessionId: string;

  private nextId = 1;
  private buf = "";
  private threadId?: string;
  private turnDone?: () => void;
  private readonly pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    channel: RemoteSessionChannel,
    toolEngine: LocalToolEngine,
    localSessionId: string,
  ) {
    super();
    this.channel = channel;
    this.toolEngine = toolEngine;
    this.localSessionId = localSessionId;

    channel.on("stdout", (chunk: string) => this.onStdout(chunk));
    channel.on("stderr", (chunk: string) => this.emit("stderr", chunk));
    channel.on("exit", (info: unknown) => {
      this.turnDone?.();
      this.turnDone = undefined;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("codex app-server exited"));
      }
      this.pending.clear();
      this.emit("exit", info);
    });
  }

  async initialize(): Promise<unknown> {
    const res = await this.request("initialize", {
      clientInfo: { name: "agent-remote", version: "0.1.0" },
    });
    this.notify("initialized", {});
    return res;
  }

  async listModels(includeHidden = false): Promise<ModelCatalogEntry[]> {
    const res = (await this.request("model/list", { includeHidden })) as CodexModelListResponse;
    return parseCodexModelList(res);
  }

  async startThread(options: {
    model?: string;
    effort?: ThinkingEffort;
    developerInstructions?: string;
  }): Promise<string> {
    const dynamicTools = this.toolEngine.listToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const res = (await this.request("thread/start", {
      model: options.model,
      reasoning_effort: options.effort,
      developerInstructions: options.developerInstructions,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      dynamicTools,
    })) as { thread?: { id?: string }; threadId?: string };

    this.threadId = res.thread?.id ?? res.threadId ?? "default";
    return this.threadId;
  }

  async prompt(text: string, options?: { model?: string; effort?: ThinkingEffort }): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread not started");
    return await new Promise<void>((resolve, reject) => {
      this.turnDone = resolve;
      void this.request(
        "turn/start",
        {
          threadId: this.threadId,
          input: [{ type: "text", text }],
          model: options?.model,
          reasoning_effort: options?.effort,
        },
        600_000,
      ).catch((err) => {
        this.turnDone = undefined;
        reject(err);
      });
    });
  }

  cancel(): void {
    if (!this.threadId) return;
    void this.request("turn/interrupt", { threadId: this.threadId }).catch(() => {});
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 25_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC "${method}" timed out`));
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
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        continue;
      }
      this.handleMsg(msg);
    }
  }

  private handleMsg(msg: JsonRpcMsg): void {
    if (msg.id !== undefined && !msg.method) {
      const entry = this.pending.get(Number(msg.id));
      if (!entry) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
      return;
    }

    if (msg.id !== undefined && msg.method) {
      void this.handleServerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }

    if (msg.method === "item/agentMessage/delta") {
      const delta = String(msg.params?.delta ?? "");
      if (delta) {
        this.emit("event", { type: "text_delta", sessionId: this.localSessionId, text: delta });
      }
    } else if (msg.method === "item/reasoning/summaryTextDelta") {
      const delta = String(msg.params?.delta ?? "");
      if (delta) {
        this.emit("event", { type: "thought_delta", sessionId: this.localSessionId, text: delta });
      }
    } else if (msg.method === "turn/completed") {
      this.turnDone?.();
      this.turnDone = undefined;
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    // Strategy A': dynamic tool execution on local workstation
    if (method === "item/tool/call") {
      const toolName = String(params.tool ?? params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = await this.toolEngine.executeTool(toolName, args, {
        sessionId: this.localSessionId,
      });
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          contentItems: [{ type: "inputText", text: outcome.content }],
          success: outcome.ok,
        },
      });
      return;
    }

    // Strategy C2: Intercept & Reject any leaked remote server shell/patch approvals with redirect steer
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          decision: "decline",
          reason:
            "Remote server execution is disabled by agent-remote. Use the local workspace dynamic tools (`read_file`, `edit_file`, `write_file`, `run_command`) instead.",
        },
      });
      return;
    }

    this.send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported Codex server request: ${method}` },
    });
  }
}
