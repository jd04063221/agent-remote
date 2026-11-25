import { describe, expect, it } from "vitest";
import { buildGeminiSpawnSpec } from "./index.js";

describe("@agent-remote/driver-gemini", () => {
  it("generates deny policy TOML, empty tools.core, and MCP-over-WSS settings", () => {
    const spec = buildGeminiSpawnSpec({
      sessionId: "gm1",
      model: "gemini-3-pro",
      nativeSubagents: [
        {
          blueprint: {
            name: "explorer",
            description: "Explore",
            systemPrompt: "Scan repo",
            tools: ["read_file"],
            executionMode: "native",
          },
          model: "flash",
        },
      ],
    });

    expect(spec.args).toEqual(["--acp", "-m", "gemini-3-pro"]);
    expect(spec.ephemeralFiles["empty/.gemini/policies/agent-remote-deny.toml"]).toContain(
      'toolName = "run_shell_command"',
    );
    expect(spec.ephemeralFiles["empty/.gemini/settings.json"]).toContain("{{MCP_URL}}");
    expect(spec.ephemeralFiles["empty/.gemini/agents/explorer.md"]).toContain("model: flash");
  });
});
