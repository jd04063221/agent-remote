import { describe, expect, it } from "vitest";
import { buildSshRemoteWrapperCommand, MotdSentinelFilter } from "./ssh-channel.js";

describe("@agent-remote/transport SSH MOTD sentinel & wrapper", () => {
  it("strips MOTD noise across chunk boundaries and unlocks cleanly at sentinel", () => {
    const filter = new MotdSentinelFilter("__AR_READY_abc__");
    expect(filter.push("Welcome to Ubuntu 24.04 LTS\nLast login: Tue\n")).toBe("");
    expect(filter.isUnlocked()).toBe(false);
    expect(filter.push("__AR_WORKDIR__=/home/dev/snap/antigravity-cli/common/ar-sessions/ar-ssh-s1/empty\n")).toBe("");
    expect(filter.push("__AR_READY_")).toBe("");
    const out = filter.push('abc__\n{"jsonrpc":"2.0","id":1}\n');
    expect(filter.isUnlocked()).toBe(true);
    expect(filter.getDiscoveredWorkdir()).toBe("/home/dev/snap/antigravity-cli/common/ar-sessions/ar-ssh-s1/empty");
    expect(out).toBe('{"jsonrpc":"2.0","id":1}\n');
    expect(filter.push('{"next":true}\n')).toBe('{"next":true}\n');
  });

  it("generates self-cleaning remote wrapper expanding MCP placeholders and handling Snap workdirs", () => {
    const cmd = buildSshRemoteWrapperCommand({
      sentinel: "__AR_READY_123__",
      mcpUrl: "http://127.0.0.1:29999/mcp",
      mcpToken: "tok-xyz",
      spec: {
        sessionId: "s1",
        agent: "gemini",
        command: "gemini",
        args: ["--acp"],
        env: {},
        ephemeralFiles: {
          "empty/.gemini/settings.json": '{"url":"{{MCP_URL}}","token":"{{MCP_TOKEN}}"}',
        },
        enableMcpBridge: true,
      },
    });
    expect(cmd).toContain("trap 'rm -rf \"$WORKDIR\"' EXIT INT TERM HUP");
    expect(cmd).toContain("__AR_WORKDIR__=%s");
    expect(cmd).toContain("/snap/*|/var/lib/snapd/snap/*");
    expect(cmd).toContain("__AR_READY_123__");
    expect(cmd).toContain("exec 'gemini' '--acp'");
    expect(cmd).toContain("AGENT_REMOTE_MCP_URL='http://127.0.0.1:29999/mcp'");
  });
});
