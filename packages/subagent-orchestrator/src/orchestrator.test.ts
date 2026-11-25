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
});
