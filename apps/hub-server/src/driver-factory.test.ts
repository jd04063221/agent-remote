import { describe, expect, it } from "vitest";
import { AGENT_KINDS } from "@agent-remote/protocol";
import { buildSpawnSpecForAgent } from "./driver-factory.js";

describe("buildSpawnSpecForAgent (all 7 agents)", () => {
  it("produces isolated remote launch specs for every supported agent kind", () => {
    for (const agent of AGENT_KINDS) {
      const res = buildSpawnSpecForAgent({
        sessionId: `s-${agent}`,
        hostId: "us-vps",
        profileId: `p-${agent}`,
        agent,
        localWorkspaceRoot: "/root/projects/agent-remote",
        localGitBranch: "main",
        model: agent === "opencode" ? "deepseek/deepseek-4.1-flash" : "default-model",
        effort: "high",
        nativePlans: [],
      });
      expect(res.spawn.agent).toBe(agent);
      expect(res.spawn.command.length).toBeGreaterThan(0);
      expect(res.spawn.enableMcpBridge).toBe(true);
    }
  });
});
