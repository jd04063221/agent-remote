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
  }>,
): string {
  if (subagents.length === 0) return "";
  const lines = [
    "[agent-remote: Quota-Saver Offloading Policy]",
    "To preserve primary model quota and keep your context window concise:",
    "1. Offload broad repository exploration, multi-file reading, boilerplate/unit-test writing, and long log summarization to the federated subagents below via `dispatch_subagent` or `call_remote_model`.",
    "2. Ask subagents to return concise, structured summaries rather than raw file dumps.",
    "3. Reserve primary turns for planning, architectural reasoning, integration, and final review.",
    "",
    "Available federated subagents for this task:",
    ...subagents.map((s) => {
      const spec = [s.targetLabel, s.model, s.effort ? `effort=${s.effort}` : undefined]
        .filter(Boolean)
        .join(" | ");
      return `- \`${s.blueprint.name}\` (${spec}): ${s.blueprint.description}`;
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
  maxChars = 12_000,
): string {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];

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
    }
  }

  if (turns.length === 0) return "";

  const rendered: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const clean = t.text.trim();
    if (!clean) continue;
    const prefix = t.role === "user" ? "User: " : "Assistant: ";
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
