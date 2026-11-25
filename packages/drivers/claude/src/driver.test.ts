import { describe, expect, it } from "vitest";
import {
  buildClaudeSpawnSpec,
  CLAUDE_DISALLOWED_BUILTINS,
  compileClaudeSubagentMarkdown,
} from "./index.js";

describe("@agent-remote/driver-claude", () => {
  it("disables remote built-in tools and compiles Track 1 subagent frontmatter", () => {
    const spec = buildClaudeSpawnSpec({
      sessionId: "c1",
      model: "opus",
      effort: "xhigh",
      localWorkspaceRoot: "/repo",
      nativeSubagents: [
        {
          blueprint: {
            name: "reviewer",
            description: "Code reviewer",
            systemPrompt: "Review diffs carefully.",
            tools: ["read_file"],
            executionMode: "native",
          },
          model: "sonnet",
          effort: "high",
        },
      ],
    });

    expect(spec.args).toContain("--disallowedTools");
    expect(spec.args).toContain(CLAUDE_DISALLOWED_BUILTINS.join(","));
    expect(spec.args).toContain("--effort");
    expect(spec.args).toContain("xhigh");
    expect(spec.ephemeralFiles["mcp-config.json"]).toContain("{{MCP_URL}}");
    const md = spec.ephemeralFiles["empty/.claude/agents/reviewer.md"]!;
    expect(md).toContain("model: sonnet");
    expect(md).toContain("effort: high");
    expect(md).toContain("- Bash");
  });

  it("compiles clean frontmatter markdown", () => {
    const md = compileClaudeSubagentMarkdown({
      blueprint: {
        name: "fast-scan",
        description: "Quick scan",
        systemPrompt: "Be fast.",
        tools: ["read_file"],
        executionMode: "native",
      },
      model: "haiku",
      effort: "low",
    });
    expect(md).toContain("name: fast-scan");
    expect(md).toContain("effort: low");
  });
});
