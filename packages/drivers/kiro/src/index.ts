import type {
  ModelCatalogEntry,
  SpawnSessionPayload,
  SubagentBlueprint,
  ThinkingEffort,
} from "@agent-remote/protocol";

export interface KiroSubagentSpec {
  blueprint: SubagentBlueprint;
  model?: string;
  effort?: ThinkingEffort;
}

export interface KiroLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  model?: string;
  effort?: ThinkingEffort;
  localWorkspaceRoot: string;
  quotaSaverPrompt?: string;
  nativeSubagents?: KiroSubagentSpec[];
}

export function buildKiroV3ProfileJson(params: {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  effort?: ThinkingEffort;
}): string {
  const profile: Record<string, unknown> = {
    name: params.name,
    description: params.description,
    prompt: params.prompt,
    tools: ["@agent_remote_local/*"],
    mcpServers: {
      agent_remote_local: {
        url: "{{MCP_URL}}",
        headers: {
          Authorization: "Bearer {{MCP_TOKEN}}",
        },
      },
    },
    permissions: {
      rules: [
        { capability: "shell", effect: "deny" },
        { capability: "fs_read", effect: "deny" },
        { capability: "fs_write", effect: "deny" },
      ],
    },
  };
  if (params.model) profile.model = params.model;
  if (params.effort) profile.effort = params.effort;
  return JSON.stringify(profile, null, 2);
}

/**
 * Builds zero-pollution `kiro-cli acp --agent ar-main` spawn spec using V3 Agent Profiles
 * that allowlist only `@agent_remote_local/*` MCP tools and deny remote shell/fs capabilities.
 */
export function buildKiroSpawnSpec(options: KiroLaunchOptions): SpawnSessionPayload {
  const mainPrompt = [
    `Local workspace root on user's workstation: ${options.localWorkspaceRoot}.`,
    "Use only `@agent_remote_local/*` tools to read, edit, and run commands locally.",
    options.quotaSaverPrompt,
  ]
    .filter(Boolean)
    .join("\n");

  const ephemeralFiles: Record<string, string> = {
    "empty/.kiro/agents/ar-main.json": buildKiroV3ProfileJson({
      name: "ar-main",
      description: "agent-remote split-plane primary Kiro session",
      prompt: mainPrompt,
      model: options.model,
      effort: options.effort,
    }),
  };

  for (const sub of options.nativeSubagents ?? []) {
    ephemeralFiles[`empty/.kiro/agents/${sub.blueprint.name}.json`] = buildKiroV3ProfileJson({
      name: sub.blueprint.name,
      description: sub.blueprint.description,
      prompt: sub.blueprint.systemPrompt || mainPrompt,
      model: sub.model,
      effort: sub.effort,
    });
  }

  return {
    sessionId: options.sessionId,
    agent: "kiro",
    command: options.remoteBin ?? "kiro-cli",
    args: ["acp", "--agent-engine=v3", "--agent", "ar-main"],
    env: {},
    ephemeralFiles,
    enableMcpBridge: true,
  };
}

export function parseKiroModelsOutput(raw: string): ModelCatalogEntry[] {
  const out: ModelCatalogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available") || trimmed.startsWith("-")) continue;
    const parts = trimmed.split(/\t+|\s{2,}/);
    const id = parts[0]?.replace(/^[*•]\s*/, "").trim();
    if (!id || id.includes(" ")) continue;
    out.push({
      id,
      displayName: parts[1]?.trim() || id,
      source: "cli-probe",
      capabilities: {
        supportsThinking: true,
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
    });
  }
  return out;
}
