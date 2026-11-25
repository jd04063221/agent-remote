import { describe, expect, it } from "vitest";
import {
  buildCodexSpawnSpec,
  compileCodexSubagentToml,
  parseCodexModelList,
} from "./index.js";

describe("@agent-remote/driver-codex", () => {
  it("parses codex app-server model/list with exact supportedReasoningEfforts", () => {
    const models = parseCodexModelList({
      models: [
        {
          model: "gpt-6.1-sol",
          name: "GPT-6.1 Sol",
          hidden: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        },
        { model: "internal-hidden", hidden: true },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("gpt-6.1-sol");
    expect(models[0]?.capabilities.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("locks remote codex into read-only sandbox + untrusted approval + reverse MCP + subagent TOML", () => {
    const built = buildCodexSpawnSpec({
      sessionId: "cx1",
      model: "gpt-5.5",
      effort: "xhigh",
      localWorkspaceRoot: "/repo",
      nativeSubagents: [
        {
          blueprint: {
            name: "explorer",
            description: "Fast repo scanner",
            systemPrompt: "Scan fast",
            tools: ["read_file"],
            executionMode: "native",
          },
          model: "gpt-5.3-codex-spark",
          effort: "low",
        },
      ],
    });

    expect(built.spawn.args).toContain("app-server");
    expect(built.spawn.args.join(" ")).toContain('sandbox_mode="read-only"');
    expect(built.spawn.args.join(" ")).toContain('approval_policy="untrusted"');
    expect(built.spawn.ephemeralFiles["codex-agents/explorer.toml"]).toContain(
      'model_reasoning_effort = "low"',
    );
    expect(compileCodexSubagentToml({
      blueprint: { name: "a", description: "d", systemPrompt: "", tools: [], executionMode: "native" },
      effort: "high",
    })).toContain('model_reasoning_effort = "high"');
  });
});
