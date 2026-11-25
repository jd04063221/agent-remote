import type {
  CatalogSnapshot,
  SubagentBlueprint,
  SubagentTaskOverride,
  ThinkingEffort,
  TokenUsageBreakdown,
} from "@agent-remote/protocol";
import type { CustomToolHandler, LocalToolEngine } from "@agent-remote/tool-plane";

export interface ResolvedSubagentPlan {
  blueprint: SubagentBlueprint;
  enabled: boolean;
  track: "native" | "federated";
  hostId: string;
  profileId: string;
  model?: string;
  effort?: ThinkingEffort;
  readOnly: boolean;
}

export interface FederatedSubagentCall {
  parentSessionId: string;
  subagentName: string;
  hostId: string;
  profileId: string;
  model?: string;
  effort?: ThinkingEffort;
  task: string;
  pureInferenceOnly: boolean;
  readOnly: boolean;
}

export interface FederatedSubagentResult {
  ok: boolean;
  output: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type FederatedExecutor = (
  call: FederatedSubagentCall,
) => Promise<FederatedSubagentResult>;

const WRITE_TOOLS = new Set(["write_file", "edit_file", "delete_file", "run_command"]);

function catalogContainsModel(catalog: CatalogSnapshot | undefined, modelId: string): boolean {
  if (!catalog || catalog.models.length === 0) return true;
  for (const m of catalog.models) {
    if (m.id === modelId) return true;
    if (m.effortVariantMap && Object.values(m.effortVariantMap).includes(modelId)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves each Subagent Blueprint + per-task Override into either Track 1 (Native Materialization)
 * or Track 2 (Hub-Orchestrated Federated Subagent).
 *
 * Main-Host-First policy:
 * - When a subagent does not explicitly select another Agent Profile, it always stays on the main
 *   model's host & agent (`parentHostId` / `parentProfileId`).
 * - If an unpinned subagent carries a foreign model ID that does not exist in the main profile's
 *   live catalog, it falls back cleanly to `parentModel` (or profile default) instead of failing.
 */
export function resolveSubagentPlans(params: {
  parentHostId: string;
  parentProfileId: string;
  parentAgent: string;
  parentModel?: string;
  blueprints: SubagentBlueprint[];
  overrides: Record<string, SubagentTaskOverride>;
  catalogsByProfile?: Record<string, CatalogSnapshot>;
}): ResolvedSubagentPlan[] {
  const plans: ResolvedSubagentPlan[] = [];

  for (const bp of params.blueprints) {
    const ov = params.overrides[bp.name];
    const enabled = ov?.enabled ?? true;
    const explicitProfileId = ov?.profileId || bp.defaultProfileId || undefined;
    const explicitHostId = ov?.hostId || (explicitProfileId ? bp.defaultHostId : undefined);
    const hostId = explicitHostId ?? params.parentHostId;
    const profileId = explicitProfileId ?? params.parentProfileId;
    const crossHostOrProfile =
      hostId !== params.parentHostId || profileId !== params.parentProfileId;

    let model = ov?.model || bp.defaultModel || undefined;
    const targetCatalog = params.catalogsByProfile?.[profileId];
    if (model && !crossHostOrProfile && !catalogContainsModel(targetCatalog, model)) {
      // Do not forward a model belonging to another agent (e.g. OpenCode) to the main host's agent
      model = undefined;
    }
    if (!model && !crossHostOrProfile && params.parentModel) {
      model = params.parentModel;
    }

    const effort = ov?.effort ?? bp.defaultEffort;
    const requestedMode = ov?.executionMode ?? bp.executionMode;

    const needsFederatedEffort =
      Boolean(effort) &&
      (params.parentAgent === "antigravity" || params.parentAgent === "gemini");

    let track: "native" | "federated";
    if (requestedMode === "federated") {
      track = "federated";
    } else if (requestedMode === "native" && !crossHostOrProfile) {
      track = "native";
    } else {
      // Auto mode upgrades to Track 2 whenever cross-agent/cross-host or independent effort is needed
      track = crossHostOrProfile || needsFederatedEffort ? "federated" : "native";
    }

    const readOnly = !bp.tools.some((t) => WRITE_TOOLS.has(t));

    plans.push({
      blueprint: bp,
      enabled,
      track,
      hostId,
      profileId,
      model,
      effort,
      readOnly,
    });
  }

  return plans;
}

/**
 * Registers Track 2 `dispatch_subagent` and `call_remote_model` tools into a thread's LocalToolEngine
 * and tracks offloaded token usage for the Quota-Saver dashboard.
 */
export function registerFederatedSubagentTools(options: {
  engine: LocalToolEngine;
  plans: ResolvedSubagentPlan[];
  executor: FederatedExecutor;
  usage: TokenUsageBreakdown;
}): void {
  const federatedPlans = options.plans.filter((p) => p.enabled && p.track === "federated");
  if (federatedPlans.length === 0) return;

  const byName = new Map(federatedPlans.map((p) => [p.blueprint.name, p]));

  const dispatchHandler: CustomToolHandler = {
    action: "mcp",
    definition: {
      name: "dispatch_subagent",
      description:
        "Delegate a scoped coding, research, or testing subtask to a configured subagent (prefers the main host's agent by default, or offloads to another configured agent profile).",
      inputSchema: {
        type: "object",
        properties: {
          subagent: {
            type: "string",
            enum: Array.from(byName.keys()),
            description: "Configured subagent name",
          },
          task: {
            type: "string",
            description: "Clear instructions and expected concise output format",
          },
        },
        required: ["subagent", "task"],
      },
    },
    execute: async (args, ctx) => {
      const name = String(args.subagent ?? "");
      const task = String(args.task ?? "");
      const plan = byName.get(name);
      if (!plan) {
        return {
          ok: false,
          content: `Unknown federated subagent "${name}". Available: ${Array.from(byName.keys()).join(", ")}`,
        };
      }
      const res = await options.executor({
        parentSessionId: ctx.sessionId,
        subagentName: name,
        hostId: plan.hostId,
        profileId: plan.profileId,
        model: plan.model,
        effort: plan.effort,
        task,
        pureInferenceOnly: false,
        readOnly: plan.readOnly,
      });
      options.usage.offloadedInputTokens += res.inputTokens ?? 0;
      options.usage.offloadedOutputTokens += res.outputTokens ?? 0;
      return { ok: res.ok, content: res.output };
    },
  };

  const callModelHandler: CustomToolHandler = {
    action: "mcp",
    definition: {
      name: "call_remote_model",
      description:
        "Run a fast, tool-free pure-inference prompt against a configured low-cost remote subagent model (e.g. for summarizing long logs, compressing context, or drafting snippets).",
      inputSchema: {
        type: "object",
        properties: {
          subagent: {
            type: "string",
            enum: Array.from(byName.keys()),
          },
          prompt: { type: "string" },
        },
        required: ["subagent", "prompt"],
      },
    },
    execute: async (args, ctx) => {
      const name = String(args.subagent ?? "");
      const prompt = String(args.prompt ?? "");
      const plan = byName.get(name);
      if (!plan) {
        return { ok: false, content: `Unknown subagent target "${name}".` };
      }
      const res = await options.executor({
        parentSessionId: ctx.sessionId,
        subagentName: name,
        hostId: plan.hostId,
        profileId: plan.profileId,
        model: plan.model,
        effort: plan.effort,
        task: prompt,
        pureInferenceOnly: true,
        readOnly: true,
      });
      options.usage.offloadedInputTokens += res.inputTokens ?? 0;
      options.usage.offloadedOutputTokens += res.outputTokens ?? 0;
      return { ok: res.ok, content: res.output };
    },
  };

  options.engine.registerCustomTool(dispatchHandler);
  options.engine.registerCustomTool(callModelHandler);
}
