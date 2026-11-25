import { describe, expect, it } from "vitest";
import { buildKiroSpawnSpec, parseKiroModelsOutput } from "./index.js";

describe("@agent-remote/driver-kiro", () => {
  it("builds V3 Kiro profile denying remote shell/fs and allowing local MCP", () => {
    const spec = buildKiroSpawnSpec({
      sessionId: "kr1",
      model: "claude-sonnet-4.6",
      effort: "xhigh",
      localWorkspaceRoot: "/repo",
      nativeSubagents: [
        {
          blueprint: {
            name: "sec-review",
            description: "Security audit",
            systemPrompt: "Audit code",
            tools: ["read_file"],
            executionMode: "native",
          },
          model: "claude-opus-4.6",
          effort: "max",
        },
      ],
    });

    expect(spec.args).toContain("acp");
    const mainJson = JSON.parse(spec.ephemeralFiles["empty/.kiro/agents/ar-main.json"]!) as {
      tools: string[];
      effort: string;
      permissions: { rules: Array<{ capability: string; effect: string }> };
    };
    expect(mainJson.tools).toEqual(["@agent_remote_local/*"]);
    expect(mainJson.effort).toBe("xhigh");
    expect(mainJson.permissions.rules.some((r) => r.capability === "shell" && r.effect === "deny")).toBe(
      true,
    );
    expect(spec.ephemeralFiles["empty/.kiro/agents/sec-review.json"]).toContain('"effort": "max"');
  });

  it("parses kiro-cli chat --list-models output", () => {
    const models = parseKiroModelsOutput(
      "Available models:\nclaude-sonnet-4.6   Claude Sonnet 4.6 (1x)\nclaude-opus-4.6     Claude Opus 4.6 (3x)\n",
    );
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4.6", "claude-opus-4.6"]);
  });
});
