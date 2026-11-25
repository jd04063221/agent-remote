import { describe, expect, it } from "vitest";
import {
  buildFactoryDroidSpawnSpec,
  compileDroidSubagentMarkdown,
  parseFactoryCustomModelsJson,
} from "./index.js";

describe("@agent-remote/driver-factory-droid", () => {
  it("expands inherit model when reasoningEffort is overridden so Droid honors it", () => {
    const md = compileDroidSubagentMarkdown(
      {
        blueprint: {
          name: "deep-analyzer",
          description: "Analyze",
          systemPrompt: "Think hard",
          tools: ["read_file"],
          executionMode: "native",
        },
        model: "inherit",
        effort: "xhigh",
      },
      "claude-opus-5-5",
    );
    expect(md).toContain("model: claude-opus-5-5");
    expect(md).toContain("reasoningEffort: high");
  });

  it("removes remote built-ins and merges BYOK customModels", () => {
    const spec = buildFactoryDroidSpawnSpec({
      sessionId: "fd1",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(spec.args).toContain("--remove-tools");
    expect(spec.args).toContain("--add-tools");
    expect(spec.ephemeralFiles["empty/.factory/mcp.json"]).toContain("{{MCP_URL}}");

    const byok = parseFactoryCustomModelsJson(
      JSON.stringify({
        customModels: [
          { displayName: "DeepSeek 4.1 Flash", model: "deepseek-4.1-flash", provider: "generic-chat-completion-api" },
        ],
      }),
    );
    expect(byok[0]?.id).toBe("custom:deepseek-4.1-flash");
    expect(byok[0]?.source).toBe("custom-byok");
  });
});
