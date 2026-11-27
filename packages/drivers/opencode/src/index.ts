import type { SpawnSessionPayload } from "@agent-remote/protocol";

export interface OpenCodeLaunchOptions {
  sessionId: string;
  remoteBin?: string;
  model?: string; // e.g. "deepseek/deepseek-4.1-flash"
  readOnly?: boolean;
  /** When true, strips all tools so OpenCode acts as a pure fast low-cost inference endpoint (`call_remote_model`). */
  pureInferenceOnly?: boolean;
  enableMcpBridge?: boolean;
  ephemeralRemote?: boolean;
}

/**
 * Builds zero-pollution `OPENCODE_CONFIG_CONTENT` and `opencode acp` launch spec.
 * Disables remote built-in filesystem/shell tools so OpenCode only operates on the local workspace via MCP-over-WSS
 * (or runs pure tool-free inference when invoked via `call_remote_model`).
 */
export function buildOpenCodeSpawnSpec(options: OpenCodeLaunchOptions): SpawnSessionPayload {
  const inlineConfig: Record<string, unknown> = {
    permission: options.pureInferenceOnly
      ? { "*": "deny" }
      : {
          "*": "deny",
          "agent_remote_local_*": "allow",
          "agent_remote_local*": "allow",
          "mcp*": "allow",
        },
    tools: {
      bash: false,
      edit: false,
      write: false,
      read: false,
      glob: false,
      grep: false,
      webfetch: false,
    },
  };

  if (options.model) {
    inlineConfig.model = options.model;
  }

  return {
    sessionId: options.sessionId,
    agent: "opencode",
    command: options.remoteBin ?? "opencode",
    args: ["acp"],
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
    },
    ephemeralFiles: {},
    enableMcpBridge: options.pureInferenceOnly ? false : (options.enableMcpBridge ?? true),
    ephemeralRemote: options.ephemeralRemote,
  };
}
