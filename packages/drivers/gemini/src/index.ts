import type { SpawnSessionPayload, SubagentBlueprint } from "@agent-remote/protocol";

const GEMINI_DENIED_BUILTINS = [
  "run_shell_command",
  "read_file",
  "write_file",
  "replace",
  "list_directory",
  "glob",
  "search_file_content",
] as const;

export interface GeminiLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  model?: string;
  nativeSubagents?: Array<{ blueprint: SubagentBlueprint; model?: string }>;
}

/**
 * Generates Gemini CLI Policy Engine TOML rules globally denying remote built-in FS/Shell tools
 * (which removes them from the model's context window cleanly).
 */
export function buildGeminiDenyPolicyToml(): string {
  return GEMINI_DENIED_BUILTINS.map(
    (tool) => `[[rule]]\ntoolName = "${tool}"\ndecision = "deny"\n`,
  ).join("\n");
}

export function compileGeminiSubagentMarkdown(bp: SubagentBlueprint, model?: string): string {
  const lines = [
    "---",
    `name: ${bp.name}`,
    `description: ${JSON.stringify(bp.description)}`,
  ];
  if (model) lines.push(`model: ${model}`);
  lines.push("---", "", bp.systemPrompt || "Use agent_remote_local MCP tools.");
  return lines.join("\n") + "\n";
}

/**
 * Builds zero-pollution `gemini --acp` spawn spec with isolated project `.gemini/` settings,
 * Policy Engine deny TOML, and MCP-over-WSS bridge registration.
 */
export function buildGeminiSpawnSpec(options: GeminiLaunchOptions): SpawnSessionPayload {
  const ephemeralFiles: Record<string, string> = {
    "empty/.gemini/policies/agent-remote-deny.toml": buildGeminiDenyPolicyToml(),
    "empty/.gemini/settings.json": JSON.stringify(
      {
        tools: { core: [] },
        mcpServers: {
          agent_remote_local: {
            httpUrl: "{{MCP_URL}}",
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
    ephemeralFiles[`empty/.gemini/agents/${sub.blueprint.name}.md`] =
      compileGeminiSubagentMarkdown(sub.blueprint, sub.model);
  }

  const args = ["--acp"];
  if (options.model) args.push("-m", options.model);

  return {
    sessionId: options.sessionId,
    agent: "gemini",
    command: options.remoteBin ?? "gemini",
    args,
    env: {},
    ephemeralFiles,
    enableMcpBridge: true,
  };
}
