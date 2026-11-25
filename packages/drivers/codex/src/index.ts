import { EventEmitter } from "node:events";
import os from "node:os";
import {
  THINKING_EFFORTS,
  type ModelCatalogEntry,
  type QuotaSnapshot,
  type QuotaWindow,
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
  ephemeralRemote?: boolean;
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
  if (options.ephemeralRemote) {
    args.push("-c", "ephemeral=true");
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

export interface CodexRateLimitWindowRaw {
  usedPercent?: number;
  used_percent?: number;
  windowDurationMins?: number;
  window_duration_mins?: number;
  resetsAt?: number | string;
  resets_at?: number | string;
}

export interface CodexRateLimitsSnapshotRaw {
  limitId?: string;
  limitName?: string;
  planType?: string;
  plan_type?: string;
  primary?: CodexRateLimitWindowRaw | null;
  secondary?: CodexRateLimitWindowRaw | null;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
  } | null;
}

function formatCodexWindowLabel(
  w: CodexRateLimitWindowRaw,
  fallback: string,
  prefix?: string,
): string {
  const mins = w.windowDurationMins ?? w.window_duration_mins;
  let base = fallback;
  if (mins === 300) base = "5-Hour Window";
  else if (mins === 10080) base = "Weekly Cap";
  else if (typeof mins === "number" && mins > 0) {
    base = mins % 60 === 0 ? `${mins / 60}h Window` : `${mins}m Window`;
  }
  return prefix ? `${prefix} · ${base}` : base;
}

function normalizeResetTime(raw?: number | string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return undefined;
}

function pushCodexWindow(
  out: QuotaWindow[],
  w: CodexRateLimitWindowRaw | null | undefined,
  fallbackLabel: string,
  prefix?: string,
): void {
  if (!w) return;
  const usedRaw = w.usedPercent ?? w.used_percent;
  if (typeof usedRaw !== "number" || !Number.isFinite(usedRaw)) return;
  const used = Math.max(0, Math.min(100, usedRaw));
  const rem = Math.max(0, Math.min(100, 100 - used));
  out.push({
    label: formatCodexWindowLabel(w, fallbackLabel, prefix),
    usedPercent: used,
    remainingPercent: rem,
    resetsAt: normalizeResetTime(w.resetsAt ?? w.resets_at),
  });
}

/**
 * Parses `codex app-server` `account/rateLimits/read` or `account/rateLimits/updated` payloads
 * into a normalized `QuotaSnapshot`.
 */
export function parseCodexRateLimits(
  raw: unknown,
  hostId: string,
  profileId: string,
): QuotaSnapshot {
  const obj = (raw ?? {}) as {
    rateLimits?: CodexRateLimitsSnapshotRaw;
    rateLimitsByLimitId?: Record<string, CodexRateLimitsSnapshotRaw>;
  } & CodexRateLimitsSnapshotRaw;

  const main = obj.rateLimits ?? obj;
  const windows: QuotaWindow[] = [];
  pushCodexWindow(windows, main.primary, "Primary Window");
  pushCodexWindow(windows, main.secondary, "Secondary Window");

  if (obj.rateLimitsByLimitId) {
    for (const [limitId, snap] of Object.entries(obj.rateLimitsByLimitId)) {
      if (snap === main || limitId === main.limitId) continue;
      const prefix = snap.limitName || limitId;
      pushCodexWindow(windows, snap.primary, "Primary Window", prefix);
      pushCodexWindow(windows, snap.secondary, "Secondary Window", prefix);
    }
  }

  if (main.credits) {
    if (main.credits.unlimited) {
      windows.push({ label: "Codex Credits", remainingAmount: "Unlimited" });
    } else if (main.credits.balance !== undefined && main.credits.balance !== null) {
      windows.push({
        label: "Codex Credits",
        remainingAmount: String(main.credits.balance),
      });
    }
  }

  return {
    hostId,
    profileId,
    agent: "codex",
    available: windows.length > 0,
    source: windows.length > 0 ? "app-server-rpc" : "unavailable",
    planTier: main.planType ?? main.plan_type,
    windows,
    note:
      windows.length === 0
        ? "Codex app-server did not return active rate limit windows (API-key mode or unauthenticated)."
        : undefined,
    fetchedAt: new Date().toISOString(),
  };
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
  private turnEmittedUsage = false;
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

  getRemoteSessionId(): string | undefined {
    return this.threadId;
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

  async readRateLimits(hostId: string, profileId: string): Promise<QuotaSnapshot> {
    const res = await this.request("account/rateLimits/read", {});
    return parseCodexRateLimits(res, hostId, profileId);
  }

  async startThread(options: {
    model?: string;
    effort?: ThinkingEffort;
    ephemeral?: boolean;
    developerInstructions?: string;
  }): Promise<string> {
    const dynamicTools = this.toolEngine.listToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const params: Record<string, unknown> = {
      model: options.model,
      reasoning_effort: options.effort,
      developerInstructions: options.developerInstructions,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      dynamicTools,
    };
    if (options.ephemeral) {
      params.ephemeral = true;
    }

    const res = (await this.request("thread/start", params)) as {
      thread?: { id?: string };
      threadId?: string;
    };

    this.threadId = res.thread?.id ?? res.threadId ?? "default";
    return this.threadId;
  }

  async resumeOrStartThread(options: {
    resumeThreadId?: string;
    ephemeral?: boolean;
    model?: string;
    effort?: ThinkingEffort;
    developerInstructions?: string;
  }): Promise<{ threadId: string; resumed: boolean }> {
    if (options.resumeThreadId && !options.ephemeral) {
      const dynamicTools = this.toolEngine.listToolDefinitions().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      try {
        const res = (await this.request("thread/resume", {
          threadId: options.resumeThreadId,
          model: options.model,
          reasoning_effort: options.effort,
          developerInstructions: options.developerInstructions,
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          dynamicTools,
        })) as { thread?: { id?: string }; threadId?: string };
        this.threadId = res.thread?.id ?? res.threadId ?? options.resumeThreadId;
        return { threadId: this.threadId, resumed: true };
      } catch {
        // Fall back to fresh thread/start
      }
    }

    const threadId = await this.startThread(options);
    return { threadId, resumed: false };
  }

  async prompt(text: string, options?: { model?: string; effort?: ThinkingEffort }): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread not started");
    this.turnEmittedUsage = false;
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
    } else if (msg.method === "account/rateLimits/updated") {
      this.emit("quota_raw", msg.params ?? {});
    } else if (msg.method === "thread/tokenUsage/updated") {
      const usage = extractCodexUsage(msg.params);
      if (usage) {
        this.turnEmittedUsage = true;
        this.emit("event", {
          type: "usage_delta",
          sessionId: this.localSessionId,
          ...usage,
          exact: true,
        });
      }
    } else if (msg.method === "turn/completed") {
      if (!this.turnEmittedUsage) {
        const usage = extractCodexUsage(msg.params);
        if (usage) {
          this.turnEmittedUsage = true;
          this.emit("event", {
            type: "usage_delta",
            sessionId: this.localSessionId,
            ...usage,
            exact: true,
          });
        }
      }
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

function extractCodexUsage(params?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
} | null {
  if (!params || typeof params !== "object") return null;
  const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
  const info = params.info as Record<string, unknown> | undefined;
  const turn = params.turn as Record<string, unknown> | undefined;
  const raw = (tokenUsage?.last ??
    info?.last_token_usage ??
    turn?.usage ??
    params.usage ??
    tokenUsage) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const inputTokens = num(raw.inputTokens ?? raw.input_tokens);
  const outputTokens = num(raw.outputTokens ?? raw.output_tokens);
  const cachedInputTokens = num(raw.cachedInputTokens ?? raw.cached_input_tokens);
  const reasoningTokens = num(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens);

  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0 && reasoningTokens === 0) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}
