import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "@agent-remote/protocol";
import { buildQuotaSaverGuidance, resolveEffortForModel } from "./index.js";

const SAMPLE_MODEL: ModelCatalogEntry = {
  id: "claude-opus-5-5",
  displayName: "Claude Opus 5.5",
  source: "live-rpc",
  effortVariantMap: {
    low: "claude-opus-5-5-low",
    medium: "claude-opus-5-5-medium",
    high: "claude-opus-5-5-high",
  },
  capabilities: {
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
  },
};

describe("resolveEffortForModel", () => {
  it("resolves exact supported effort to matching variant slug", () => {
    const res = resolveEffortForModel(SAMPLE_MODEL, "low");
    expect(res.downgraded).toBe(false);
    expect(res.resolved).toBe("low");
    expect(res.resolvedModelSlug).toBe("claude-opus-5-5-low");
  });

  it("maps unsupported xhigh to nearest high with explicit warning", () => {
    const res = resolveEffortForModel(SAMPLE_MODEL, "xhigh");
    expect(res.downgraded).toBe(true);
    expect(res.resolved).toBe("high");
    expect(res.resolvedModelSlug).toBe("claude-opus-5-5-high");
    expect(res.warning).toContain("xhigh");
  });
});

describe("buildQuotaSaverGuidance", () => {
  it("lists federated low-cost subagents cleanly", () => {
    const text = buildQuotaSaverGuidance([
      {
        blueprint: {
          name: "explorer",
          description: "Fast codebase scan",
          systemPrompt: "",
          tools: ["read_file", "grep"],
          executionMode: "federated",
        },
        targetLabel: "us-vps/opencode",
        model: "deepseek/deepseek-4.1-flash",
        effort: "low",
      },
    ]);
    expect(text).toContain("dispatch_subagent");
    expect(text).toContain("deepseek/deepseek-4.1-flash");
  });
});
