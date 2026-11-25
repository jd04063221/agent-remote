import { describe, expect, it } from "vitest";
import { buildAntigravitySpawnSpec } from "./index.js";

describe("@agent-remote/driver-antigravity", () => {
  it("builds agy acp isolated launch spec with local workspace and quota-saver instructions", () => {
    const built = buildAntigravitySpawnSpec({
      sessionId: "s-agy-1",
      localWorkspaceRoot: "/root/projects/agent-remote",
      localGitBranch: "feat/phase1",
      quotaSaverPrompt: "Offload search to explorer (deepseek-4.1-flash)",
    });

    expect(built.spawn.command).toBe("agy");
    expect(built.spawn.args).toContain("acp");
    expect(built.spawn.args).toContain("--process-per-session");
    expect(built.spawn.enableMcpBridge).toBe(true);
    expect(built.systemPromptAppend).toContain("/root/projects/agent-remote");
    expect(built.systemPromptAppend).toContain("agent_remote_local");
    expect(built.systemPromptAppend).toContain("deepseek-4.1-flash");
  });
});
