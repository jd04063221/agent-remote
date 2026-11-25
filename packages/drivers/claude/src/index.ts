import { EventEmitter } from "node:events";
import {
  describeLocalRuntimeEnv,
  type ModelCatalogEntry,
  SpawnSessionPayload,
  SubagentBlueprint,
  ThinkingEffort,
} from "@agent-remote/protocol";
import type { RemoteSessionChannel } from "@agent-remote/transport";

export const CLAUDE_DISALLOWED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
] as const;

export interface ClaudeSubagentSpec {
  blueprint: SubagentBlueprint;
  model?: string;
  effort?: ThinkingEffort;
}

export interface ClaudeLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  model?: string;
  effort?: ThinkingEffort;
  resumeRemoteSessionId?: string;
  /** When true, passes `--no-session-persistence` so Claude does not persist transcripts on the remote host. */
  ephemeralRemote?: boolean;
  localWorkspaceRoot: string;
  localGitBranch?: string;
  quotaSaverPrompt?: string;
  nativeSubagents?: ClaudeSubagentSpec[];
}

/**
 * Compiles a canonical Subagent blueprint into Claude Code `.claude/agents/<name>.md` YAML frontmatter.
 * Preserves per-subagent `model` and `effort` while ensuring remote built-in FS/Shell tools stay disallowed.
 */
export function compileClaudeSubagentMarkdown(spec: ClaudeSubagentSpec): string {
  const fm: string[] = [
    "---",
    `name: ${spec.blueprint.name}`,
    `description: ${JSON.stringify(spec.blueprint.description)}`,
  ];
  if (spec.model) fm.push(`model: ${spec.model}`);
  if (spec.effort) fm.push(`effort: ${spec.effort}`);
  fm.push("disallowedTools:");
  for (const t of CLAUDE_DISALLOWED_BUILTINS) {
    fm.push(`  - ${t}`);
  }
  fm.push("---", "");
  fm.push(
    spec.blueprint.systemPrompt ||
      "Use only the `agent_remote_local` MCP tools to inspect or edit files on the user's local machine.",
  );
  return fm.join("\n") + "\n";
}

/**
 * Builds the remote Claude Code CLI launch specification with disabled remote built-ins,
 * ephemeral MCP-over-WSS config (expanded atomically by Go remote-node), and Track 1 subagent files.
 */
export function buildClaudeSpawnSpec(options: ClaudeLaunchOptions): SpawnSessionPayload {
  const ephemeralFiles: Record<string, string> = {
    "mcp-config.json": JSON.stringify(
      {
        mcpServers: {
          agent_remote_local: {
            type: "http",
            url: "{{MCP_URL}}",
            headers: {
              Authorization: "Bearer {{MCP_TOKEN}}",
            },
          },
        },
      },
      null,
      2,
    ),
  };

  for (const sub of options.nativeSubagents ?? []) {
    ephemeralFiles[`empty/.claude/agents/${sub.blueprint.name}.md`] =
      compileClaudeSubagentMarkdown(sub);
  }

  const sysPrompt = [
    "[agent-remote: Split-Plane Claude Code Environment]",
    `The user's repository lives on their LOCAL machine (${describeLocalRuntimeEnv()}), NOT on this server.`,
    `Local workspace root: ${options.localWorkspaceRoot}`,
    options.localGitBranch ? `Git branch: ${options.localGitBranch}` : undefined,
    "Built-in server file/shell tools are disabled. Use `mcp__agent_remote_local__*` tools for all file and shell actions.",
    options.quotaSaverPrompt ? `\n${options.quotaSaverPrompt}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  const args: string[] = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disallowedTools",
    CLAUDE_DISALLOWED_BUILTINS.join(","),
    "--mcp-config",
    "../mcp-config.json",
    "--append-system-prompt",
    sysPrompt,
  ];

  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.ephemeralRemote) {
    args.push("--no-session-persistence");
  } else if (options.resumeRemoteSessionId) {
    args.push("--resume", options.resumeRemoteSessionId);
  }

  return {
    sessionId: options.sessionId,
    agent: "claude",
    command: options.remoteBin ?? "claude",
    args,
    env: {},
    ephemeralFiles,
    enableMcpBridge: true,
  };
}

/**
 * Stream-JSON NDJSON session controller for Claude Code over Tailnet WSS / stdio.
 */
export class ClaudeStreamSession extends EventEmitter {
  private readonly channel: RemoteSessionChannel;
  private readonly localSessionId: string;
  private buf = "";
  private remoteSessionId?: string;
  private turnResolver?: () => void;
  private pendingTurnUsage = { input: 0, output: 0, cached: 0 };

  constructor(channel: RemoteSessionChannel, localSessionId: string) {
    super();
    this.channel = channel;
    this.localSessionId = localSessionId;

    channel.on("stdout", (chunk: string) => this.onStdout(chunk));
    channel.on("stderr", (chunk: string) => this.emit("stderr", chunk));
    channel.on("exit", (info: unknown) => {
      this.turnResolver?.();
      this.turnResolver = undefined;
      this.emit("exit", info);
    });
  }

  getRemoteSessionId(): string | undefined {
    return this.remoteSessionId;
  }

  async prompt(text: string): Promise<void> {
    this.pendingTurnUsage = { input: 0, output: 0, cached: 0 };
    return await new Promise<void>((resolve) => {
      this.turnResolver = resolve;
      const msg = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      };
      this.channel.writeStdin(JSON.stringify(msg) + "\n");
    });
  }

  cancel(): void {
    this.channel.kill();
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof ev.session_id === "string" && ev.session_id) {
        this.remoteSessionId = ev.session_id;
        this.emit("remote_session_id", ev.session_id);
      }
      if (ev.type === "assistant") {
        const msg = ev.message as
          | {
              content?: Array<Record<string, unknown>>;
              usage?: Record<string, unknown>;
            }
          | undefined;
        if (msg?.usage) {
          this.pendingTurnUsage.input += Number(msg.usage.input_tokens ?? 0) || 0;
          this.pendingTurnUsage.output += Number(msg.usage.output_tokens ?? 0) || 0;
          this.pendingTurnUsage.cached +=
            (Number(msg.usage.cache_read_input_tokens ?? 0) || 0) +
            (Number(msg.usage.cache_creation_input_tokens ?? 0) || 0);
        }
        for (const block of msg?.content ?? []) {
          if (block.type === "thinking" && typeof block.thinking === "string") {
            this.emit("event", {
              type: "thought_delta",
              sessionId: this.localSessionId,
              text: block.thinking,
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            this.emit("event", {
              type: "text_delta",
              sessionId: this.localSessionId,
              text: block.text,
            });
          }
        }
      } else if (ev.type === "result") {
        const u = ev.usage as Record<string, unknown> | undefined;
        const inputTokens = u ? Number(u.input_tokens ?? 0) || 0 : this.pendingTurnUsage.input;
        const outputTokens = u ? Number(u.output_tokens ?? 0) || 0 : this.pendingTurnUsage.output;
        const cachedInputTokens = u
          ? (Number(u.cache_read_input_tokens ?? 0) || 0) +
            (Number(u.cache_creation_input_tokens ?? 0) || 0)
          : this.pendingTurnUsage.cached;
        const costRaw = ev.total_cost_usd ?? ev.cost_usd;
        const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : undefined;

        if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
          this.emit("event", {
            type: "usage_delta",
            sessionId: this.localSessionId,
            inputTokens,
            outputTokens,
            ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            exact: true,
          });
        }
        this.pendingTurnUsage = { input: 0, output: 0, cached: 0 };
        this.turnResolver?.();
        this.turnResolver = undefined;
      }
    }
  }
}

export function getClaudeFallbackModels(): ModelCatalogEntry[] {
  return [
    {
      id: "opus",
      displayName: "Claude Opus (Default Alias)",
      source: "fallback",
      isDefault: true,
      capabilities: {
        supportsThinking: true,
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
    },
    {
      id: "sonnet",
      displayName: "Claude Sonnet (Default Alias)",
      source: "fallback",
      capabilities: {
        supportsThinking: true,
        supportedEfforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
      },
    },
    {
      id: "haiku",
      displayName: "Claude Haiku (Fast Alias)",
      source: "fallback",
      capabilities: {
        supportsThinking: true,
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "low",
      },
    },
  ];
}
