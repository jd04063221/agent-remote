import { describe, expect, it } from "vitest";
import {
  parseConfigToml,
  parsePermissionRuleExpr,
  STARTER_CONFIG_TOML,
} from "./config.js";

describe("TOML configuration loader", () => {
  it("parses the starter multi-host/quota-saver config cleanly", () => {
    const cfg = parseConfigToml(STARTER_CONFIG_TOML);
    expect(cfg.hub.default_profile).toBe("us-agy");
    expect(cfg.hosts["us-vps"]?.transport).toBe("tailnet-direct");
    expect(cfg.profiles["us-opencode"]?.default_model).toBe("deepseek/deepseek-4.1-flash");
    expect(cfg.subagents.explorer?.execution_mode).toBe("federated");
    expect(cfg.task_presets["agy-quota-saver"]?.quota_saver_mode).toBe(true);
    expect(cfg.permissions.deny).toContain("command(sudo *)");
  });

  it("parses compact permission rule expressions", () => {
    expect(parsePermissionRuleExpr("command(git status*)", "allow")).toEqual({
      action: "command",
      pattern: "git status*",
      decision: "allow",
    });
    expect(parsePermissionRuleExpr("write(.git/**)", "deny")).toEqual({
      action: "write",
      pattern: ".git/**",
      decision: "deny",
    });
    expect(parsePermissionRuleExpr("invalid-rule", "allow")).toBeNull();
  });
});
