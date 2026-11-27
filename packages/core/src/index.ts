import {
  THINKING_EFFORTS,
  type AgentKind,
  type CatalogSnapshot,
  type ModelCatalogEntry,
  type SubagentBlueprint,
  type TaskOverride,
  type ThinkingEffort,
} from "@agent-remote/protocol";

export type SplitStrategy =
  | "inline-control-channel"
  | "reverse-mcp"
  | "acp-delegation"
  | "approval-intercept";

export type CanonicalEvent =
  | { type: "thought_delta"; sessionId: string; text: string }
  | { type: "text_delta"; sessionId: string; text: string }
  | {
      type: "tool_call_proposed";
      sessionId: string;
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_call_completed";
      sessionId: string;
      callId: string;
      ok: boolean;
      summary: string;
    }
  | {
      type: "subagent_spawned";
      parentSessionId: string;
      childSessionId: string;
      subagentName: string;
      hostId: string;
      profileId: string;
      model?: string;
      effort?: ThinkingEffort;
    }
  | {
      type: "usage_delta";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
      exact: boolean;
    }
  | {
      type: "turn_completed";
      sessionId: string;
      stopReason: "end_turn" | "cancelled" | "error";
    };

export interface EffortResolution {
  resolved?: ThinkingEffort;
  resolvedModelSlug: string;
  downgraded: boolean;
  warning?: string;
}

/**
 * Resolves a requested ThinkingEffort against a model's live advertised capabilities.
 * Never silently drops an unsupported effort — always emits an explicit warning and chooses the nearest valid level.
 */
export function resolveEffortForModel(
  model: ModelCatalogEntry,
  requested?: ThinkingEffort,
): EffortResolution {
  const supported = model.capabilities.supportedEfforts;
  if (!requested) {
    const def = model.capabilities.defaultEffort;
    const slug = (def && model.effortVariantMap?.[def]) || model.id;
    return { resolved: def, resolvedModelSlug: slug, downgraded: false };
  }

  if (supported.length === 0) {
    return {
      resolved: undefined,
      resolvedModelSlug: model.id,
      downgraded: true,
      warning: `Model "${model.displayName}" does not advertise configurable thinking effort; ignoring requested "${requested}".`,
    };
  }

  if (supported.includes(requested)) {
    return {
      resolved: requested,
      resolvedModelSlug: model.effortVariantMap?.[requested] ?? model.id,
      downgraded: false,
    };
  }

  const reqIdx = THINKING_EFFORTS.indexOf(requested);
  let nearest = supported[0]!;
  let bestDist = Math.abs(THINKING_EFFORTS.indexOf(nearest) - reqIdx);
  for (const candidate of supported) {
    const dist = Math.abs(THINKING_EFFORTS.indexOf(candidate) - reqIdx);
    if (dist < bestDist) {
      nearest = candidate;
      bestDist = dist;
    }
  }

  return {
    resolved: nearest,
    resolvedModelSlug: model.effortVariantMap?.[nearest] ?? model.id,
    downgraded: true,
    warning: `Model "${model.displayName}" does not support effort "${requested}" (supported: ${supported.join(", ")}); mapped to nearest "${nearest}".`,
  };
}

/**
 * Generates system prompt guidance injected into the primary remote agent when Quota-Saver mode is enabled,
 * instructing it to offload heavy context exploration, boilerplate edits, and log compression to cheaper subagents.
 */
export function buildQuotaSaverGuidance(
  subagents: Array<{
    blueprint: SubagentBlueprint;
    targetLabel: string;
    model?: string;
    effort?: ThinkingEffort;
    isLocalHost?: boolean;
  }>,
  options?: { quotaSaverMode?: boolean },
): string {
  if (subagents.length === 0) return "";
  const quotaSaver = options?.quotaSaverMode ?? true;
  const explorerName =
    subagents.find((s) => s.blueprint.name === "explorer")?.blueprint.name ??
    subagents[0]!.blueprint.name;
  const lines = [
    quotaSaver
      ? "[agent-remote: Local Subagent Capabilities & Quota-Saver Offloading Policy]"
      : "[agent-remote: Available Local & Federated Subagents]",
    "You have access to the `dispatch_subagent` MCP tool (under `agent_remote_local`), which spawns specialized worker agents that execute directly against the user's LOCAL workspace (`read_file`, `list_dir`, `glob`, `grep`, and for non-read-only subagents `edit_file`/`write_file`/`run_command`).",
    quotaSaver
      ? `MANDATORY DELEGATION RULE (Quota-Saver ON): Whenever a task requires traversing directories, scanning/auditing the repository, searching across multiple files, summarizing project structure, or writing scoped boilerplate/tests, you MUST invoke \`dispatch_subagent\` (e.g. \`{"subagent":"${explorerName}","task":"..."}\`) FIRST instead of repeatedly calling \`list_dir\`/\`glob\`/\`grep\`/\`read_file\` yourself.`
      : `DELEGATION GUIDANCE: For broad repository traversal, multi-file exploration, or scoped parallel edits/tests, prefer delegating to \`dispatch_subagent\` (e.g. \`{"subagent":"${explorerName}","task":"..."}\`) to keep your main context clean and fast.`,
    "Ask subagents to return concise, structured findings with exact file paths and line numbers rather than dumping entire files.",
    "Reserve direct single-file reads and primary turns for architecture, final synthesis, and verification.",
    "",
    "Active federated subagents available via `dispatch_subagent`:",
    ...subagents.map((s) => {
      const spec = [
        s.isLocalHost ? `LOCAL worker (${s.targetLabel})` : s.targetLabel,
        s.model,
        s.effort ? `effort=${s.effort}` : undefined,
      ]
        .filter(Boolean)
        .join(" | ");
      return `- \`${s.blueprint.name}\` [${spec}]: ${s.blueprint.description}`;
    }),
  ];
  return lines.join("\n");
}

/**
 * Formats locally persisted thread events into a concise conversation transcript
 * used to seamlessly restore context whenever native remote session resume is unavailable
 * or remote incognito (ephemeral) mode is enabled.
 */
export function formatLocalHistoryContext(
  events: Array<{ kind: string; payload: Record<string, unknown> }>,
  maxChars = 24_000,
): string {
  const turns: Array<{ role: "user" | "assistant" | "subagent"; label?: string; text: string }> = [];

  for (const ev of events) {
    if (ev.kind === "user_message" && typeof ev.payload.text === "string" && ev.payload.text.trim()) {
      turns.push({ role: "user", text: ev.payload.text.trim() });
    } else if (ev.kind === "text_delta" && typeof ev.payload.text === "string") {
      const last = turns[turns.length - 1];
      if (last && last.role === "assistant") {
        last.text += ev.payload.text;
      } else {
        turns.push({ role: "assistant", text: ev.payload.text });
      }
    } else if (ev.kind === "subagent_completed" && ev.payload.ok === true) {
      const name = typeof ev.payload.subagentName === "string" ? ev.payload.subagentName : "subagent";
      const summaryRaw =
        typeof ev.payload.text === "string" && ev.payload.text.trim()
          ? ev.payload.text.trim()
          : typeof ev.payload.preview === "string"
            ? ev.payload.preview.trim()
            : "";
      if (summaryRaw) {
        const clipped = summaryRaw.length > 1200 ? `${summaryRaw.slice(0, 1200)}...` : summaryRaw;
        turns.push({ role: "subagent", label: name, text: clipped });
      }
    }
  }

  if (turns.length === 0) return "";

  const rendered: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const clean = t.text.trim();
    if (!clean) continue;
    const prefix =
      t.role === "user"
        ? "User: "
        : t.role === "subagent"
          ? `Subagent(${t.label ?? "worker"}): `
          : "Assistant: ";
    const entry = `${prefix}${clean}`;
    if (used + entry.length > maxChars && rendered.length > 0) break;
    rendered.unshift(entry.slice(0, maxChars));
    used += entry.length;
  }

  if (rendered.length === 0) return "";
  return [
    "[agent-remote: Restored Local Conversation History]",
    "The remote agent session was restarted or is running in incognito mode.",
    "Continue seamlessly using this locally persisted transcript from previous turns:",
    "",
    ...rendered,
    "",
    "[End of Restored History]",
  ].join("\n");
}

export { describeLocalRuntimeEnv } from "@agent-remote/protocol";

export interface AgentProbeReport {
  agent: AgentKind;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  authenticated?: boolean;
  notes?: string[];
}

export interface AgentDriver {
  readonly kind: AgentKind;
  readonly supportedStrategies: readonly SplitStrategy[];

  probe(hostId: string): Promise<AgentProbeReport>;
  discoverCatalog(hostId: string, profileId: string): Promise<CatalogSnapshot>;
  prepareLaunchSpec(override: TaskOverride): Promise<{
    command: string;
    args: string[];
    env: Record<string, string>;
    ephemeralFiles: Record<string, string>;
  }>;
}

export * from "./config.js";
