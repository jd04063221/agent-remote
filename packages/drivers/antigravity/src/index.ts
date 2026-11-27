import { describeLocalRuntimeEnv, type SpawnSessionPayload } from "@agent-remote/protocol";

export interface AgyLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  localWorkspaceRoot: string;
  localGitBranch?: string;
  quotaSaverPrompt?: string;
  enableMcpBridge?: boolean;
  ephemeralRemote?: boolean;
}

/**
 * Builds the remote `agy acp` spawn specification and local-environment system prompt appendix.
 */
export function buildAntigravitySpawnSpec(options: AgyLaunchOptions): {
  spawn: SpawnSessionPayload;
  systemPromptAppend: string;
} {
  const localEnvPrompt = [
    "[agent-remote: Split-Plane Execution Environment & Local Capabilities]",
    `Your workspace files and shell live on the user's LOCAL machine (${describeLocalRuntimeEnv()}), NOT on this remote server.`,
    `Local workspace root: ${options.localWorkspaceRoot}`,
    options.localGitBranch ? `Current git branch: ${options.localGitBranch}` : undefined,
    "CRITICAL RULE: Do NOT inspect or modify files on the remote server filesystem.",
    "Local capabilities exposed through the `agent_remote_local` MCP server:",
    "- Direct local workspace tools: `read_file`, `edit_file`, `write_file`, `delete_file`, `list_dir`, `glob`, `grep`, `run_command` (plus any mounted `local_mcp__*` tools).",
    "- Federated subagent delegation: `dispatch_subagent` (and `call_remote_model`) can delegate repository traversal, multi-file reading/searching, log analysis, and scoped code edits directly to fast worker agents (including agents running locally on the user's machine with zero remote-hop latency).",
    "ALWAYS use `agent_remote_local` MCP tools — and prefer `dispatch_subagent` for multi-file codebase traversal/exploration when subagents are listed below.",
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
      ephemeralRemote: options.ephemeralRemote,
    },
    systemPromptAppend: localEnvPrompt,
  };
}

export * from "./acp-session.js";
