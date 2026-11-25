import type {
  ModelCatalogEntry,
  SpawnSessionPayload,
  SubagentBlueprint,
  ThinkingEffort,
} from "@agent-remote/protocol";

export const DROID_REMOVED_BUILTINS = [
  "Execute",
  "Read",
  "Edit",
  "Create",
  "ApplyPatch",
  "Grep",
  "Glob",
  "LS",
] as const;

export interface DroidSubagentSpec {
  blueprint: SubagentBlueprint;
  model?: string;
  effort?: ThinkingEffort;
}

export interface DroidLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  model?: string;
  effort?: ThinkingEffort;
  nativeSubagents?: DroidSubagentSpec[];
}

function mapEffortToDroid(effort?: ThinkingEffort): "low" | "medium" | "high" | undefined {
  if (!effort || effort === "off") return undefined;
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

/**
 * Compiles a custom Droid subagent markdown file (`.factory/droids/<name>.md`).
 * Automatically expands `model: inherit` to `fallbackParentModel` whenever `reasoningEffort` is set,
 * preventing Factory Droid from ignoring `reasoningEffort` on inherited models.
 */
export function compileDroidSubagentMarkdown(
  spec: DroidSubagentSpec,
  fallbackParentModel?: string,
): string {
  const droidEffort = mapEffortToDroid(spec.effort);
  let resolvedModel = spec.model;
  if ((!resolvedModel || resolvedModel === "inherit") && droidEffort && fallbackParentModel) {
    resolvedModel = fallbackParentModel;
  }

  const lines = [
    "---",
    `name: ${spec.blueprint.name}`,
    `description: ${JSON.stringify(spec.blueprint.description)}`,
  ];
  if (resolvedModel) lines.push(`model: ${resolvedModel}`);
  if (droidEffort) lines.push(`reasoningEffort: ${droidEffort}`);
  lines.push('tools: ["MCP:agent_remote_local"]');
  lines.push("---", "", spec.blueprint.systemPrompt || "Use agent_remote_local MCP tools.");
  return lines.join("\n") + "\n";
}

/**
 * Builds zero-pollution Factory Droid spawn spec using `--remove-tools` + `--add-tools MCP:agent_remote_local`
 * and isolated `.factory/mcp.json` + `.factory/droids/*.md`.
 */
export function buildFactoryDroidSpawnSpec(options: DroidLaunchOptions): SpawnSessionPayload {
  const ephemeralFiles: Record<string, string> = {
    "empty/.factory/mcp.json": JSON.stringify(
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
    ephemeralFiles[`empty/.factory/droids/${sub.blueprint.name}.md`] =
      compileDroidSubagentMarkdown(sub, options.model);
  }

  const args: string[] = [
    "exec",
    "--output-format",
    "acp",
    "--input-format",
    "acp",
    "--remove-tools",
    DROID_REMOVED_BUILTINS.join(","),
    "--add-tools",
    "MCP:agent_remote_local",
  ];
  if (options.model) args.push("-m", options.model);
  const droidEffort = mapEffortToDroid(options.effort);
  if (droidEffort) args.push("--reasoning-effort", droidEffort);

  return {
    sessionId: options.sessionId,
    agent: "factory-droid",
    command: options.remoteBin ?? "droid",
    args,
    env: {},
    ephemeralFiles,
    enableMcpBridge: true,
  };
}

/**
 * Parses Factory `~/.factory/settings.json` BYOK `customModels` array into normalized ModelCatalogEntry records.
 */
export function parseFactoryCustomModelsJson(rawSettingsJson: string): ModelCatalogEntry[] {
  try {
    const parsed = JSON.parse(rawSettingsJson) as {
      customModels?: Array<{
        displayName?: string;
        model?: string;
        provider?: string;
        maxOutputTokens?: number;
      }>;
    };
    return (parsed.customModels ?? [])
      .filter((m) => Boolean(m.model))
      .map((m) => ({
        id: `custom:${m.model!}`,
        displayName: m.displayName || m.model!,
        source: "custom-byok" as const,
        capabilities: {
          supportsThinking: true,
          supportedEfforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
      }));
  } catch {
    return [];
  }
}
