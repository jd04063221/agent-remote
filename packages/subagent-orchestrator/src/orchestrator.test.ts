import { describe, expect, it } from "vitest";
import { resolveSubagentPlans } from "./index.js";

describe("resolveSubagentPlans", () => {
  it("routes cross-agent deepseek offload and agy per-subagent effort to Track 2 federated", () => {
    const plans = resolveSubagentPlans({
      parentHostId: "us-vps",
      parentProfileId: "us-agy",
      parentAgent: "antigravity",
      blueprints: [
        {
          name: "explorer",
          description: "Fast scan",
          systemPrompt: "",
          tools: ["read_file", "grep"],
          executionMode: "auto",
          defaultProfileId: "us-opencode",
          defaultModel: "deepseek/deepseek-4.1-flash",
          defaultEffort: "low",
        },
        {
          name: "architect",
          description: "Deep design",
          systemPrompt: "",
          tools: ["read_file"],
          executionMode: "auto",
          defaultEffort: "xhigh",
        },
      ],
      overrides: {},
    });

    const explorer = plans.find((p) => p.blueprint.name === "explorer")!;
    expect(explorer.track).toBe("federated");
    expect(explorer.profileId).toBe("us-opencode");
    expect(explorer.model).toBe("deepseek/deepseek-4.1-flash");
    expect(explorer.readOnly).toBe(true);

    const architect = plans.find((p) => p.blueprint.name === "architect")!;
    expect(architect.track).toBe("federated");
    expect(architect.effort).toBe("xhigh");
  });

  it("prefers the main host's agent and strips incompatible foreign models when unpinned", () => {
    const agyCatalog = {
      hostId: "remote-vps",
      profileId: "remote-agy",
      agent: "antigravity" as const,
      fetchedAt: "2026-11-25T00:00:00Z",
      models: [
        {
          id: "gemini-4-neon",
          displayName: "Gemini 4 Neon",
          source: "live-rpc" as const,
          capabilities: {
            supportsThinking: true,
            supportedEfforts: ["low", "medium", "high", "xhigh"] as const,
          },
        },
      ],
    };

    const plans = resolveSubagentPlans({
      parentHostId: "remote-vps",
      parentProfileId: "remote-agy",
      parentAgent: "antigravity",
      parentModel: "gemini-4-neon",
      catalogsByProfile: { "remote-agy": agyCatalog as never },
      blueprints: [
        {
          name: "explorer",
          description: "Scan",
          systemPrompt: "",
          tools: ["read_file"],
          executionMode: "auto",
          defaultModel: "deepseek/deepseek-4.1-flash",
        },
        {
          name: "implementer",
          description: "Offloaded to local OpenCode",
          systemPrompt: "",
          tools: ["edit_file"],
          executionMode: "auto",
          defaultHostId: "local-box",
          defaultProfileId: "local-opencode",
          defaultModel: "opencode-go/deepseek-v4.1-flash",
        },
      ],
      overrides: {},
    });

    const explorer = plans.find((p) => p.blueprint.name === "explorer")!;
    expect(explorer.hostId).toBe("remote-vps");
    expect(explorer.profileId).toBe("remote-agy");
    expect(explorer.model).toBe("gemini-4-neon");

    const implementer = plans.find((p) => p.blueprint.name === "implementer")!;
    expect(implementer.hostId).toBe("local-box");
    expect(implementer.profileId).toBe("local-opencode");
    expect(implementer.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(implementer.track).toBe("federated");
  });
});
