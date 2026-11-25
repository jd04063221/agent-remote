import { describe, expect, it } from "vitest";
import { buildOpenCodeSpawnSpec } from "./index.js";

describe("@agent-remote/driver-opencode", () => {
  it("disables remote built-in tools and injects deepseek model via OPENCODE_CONFIG_CONTENT", () => {
    const spec = buildOpenCodeSpawnSpec({
      sessionId: "s-oc-1",
      model: "deepseek/deepseek-4.1-flash",
    });

    expect(spec.command).toBe("opencode");
    expect(spec.args).toEqual(["acp"]);
    expect(spec.enableMcpBridge).toBe(true);

    const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!) as {
      model: string;
      tools: Record<string, boolean>;
      permission: Record<string, string>;
    };
    expect(cfg.model).toBe("deepseek/deepseek-4.1-flash");
    expect(cfg.tools.bash).toBe(false);
    expect(cfg.tools.edit).toBe(false);
    expect(cfg.permission["*"]).toBe("deny");
    expect(cfg.permission["agent_remote_local_*"]).toBe("allow");
  });

  it("disables MCP bridge and all permissions in pureInferenceOnly mode", () => {
    const spec = buildOpenCodeSpawnSpec({
      sessionId: "s-oc-2",
      model: "deepseek/deepseek-4.1-flash",
      pureInferenceOnly: true,
    });
    expect(spec.enableMcpBridge).toBe(false);
    const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!) as {
      permission: Record<string, string>;
    };
    expect(cfg.permission).toEqual({ "*": "deny" });
  });
});
