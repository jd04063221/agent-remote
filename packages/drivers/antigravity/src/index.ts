import { describeLocalRuntimeEnv, type SpawnSessionPayload } from "@agent-remote/protocol";

export interface AgyLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  localWorkspaceRoot: string;
  localGitBranch?: string;
  quotaSaverPrompt?: string;
  enableMcpBridge?: boolean;
}

/**
 * Builds the remote `agy acp` spawn specification and local-environment system prompt appendix.
 */
export function buildAntigravitySpawnSpec(options: AgyLaunchOptions): {
  spawn: SpawnSessionPayload;
  systemPromptAppend: string;
} {
  const localEnvPrompt = [
    "[agent-remote: Split-Plane Execution Environment]",
    `Your workspace files and shell live on the user's LOCAL machine (${describeLocalRuntimeEnv()}), NOT on this remote server.`,
    `Local workspace root: ${options.localWorkspaceRoot}`,
    options.localGitBranch ? `Current git branch: ${options.localGitBranch}` : undefined,
    "CRITICAL RULE: Do NOT inspect or modify files on the remote server filesystem.",
    "ALWAYS use the `agent_remote_local` MCP tools (`read_file`, `edit_file`, `write_file`, `delete_file`, `list_dir`, `glob`, `grep`, `run_command`) to read/edit code and run commands on the user's local machine.",
    options.quotaSaverPrompt ? `\n${options.quotaSaverPrompt}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    spawn: {
      sessionId: options.sessionId,
      agent: "antigravity",
      command: options.remoteBin ?? "agy",
      args: ["acp", "--stdio", "--process-per-session"],
      env: {},
      ephemeralFiles: {},
      enableMcpBridge: options.enableMcpBridge ?? true,
    },
    systemPromptAppend: localEnvPrompt,
  };
}

export * from "./acp-session.js";
