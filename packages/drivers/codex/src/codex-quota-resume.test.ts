import { EventEmitter } from "node:events";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { LocalToolEngine, PolicyEngine, WorkspaceSandbox } from "@agent-remote/tool-plane";
import type { RemoteSessionChannel } from "@agent-remote/transport";
import {
  buildCodexSpawnSpec,
  CodexAppServerSession,
  parseCodexRateLimits,
} from "./index.js";

class MockChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId = "mock-codex";
  readonly channel = 1;
  readonly workdir = "/tmp/empty";
  readonly sent: Array<Record<string, unknown>> = [];

  writeStdin(data: string): void {
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      this.sent.push(msg);
      this.emit("mock_in", msg);
    }
  }
  setMcpHandler(): void {}
  kill(): void {}
  reply(obj: Record<string, unknown>): void {
    this.emit("stdout", JSON.stringify(obj) + "\n");
  }
}

describe("Codex driver: live rateLimits quota, thread/resume, incognito, and exact token usage", () => {
  it("adds -c ephemeral=true when ephemeralRemote is enabled", () => {
    const built = buildCodexSpawnSpec({
      sessionId: "s1",
      localWorkspaceRoot: "/tmp/repo",
      ephemeralRemote: true,
    });
    expect(built.spawn.args).toContain("ephemeral=true");
  });

  it("parses Codex account/rateLimits/read into normalized QuotaSnapshot", () => {
    const snap = parseCodexRateLimits(
      {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1795500000 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1795900000 },
          credits: { hasCredits: true, unlimited: false, balance: "$18.50" },
        },
      },
      "us-vps",
      "us-codex",
    );
    expect(snap.available).toBe(true);
    expect(snap.source).toBe("app-server-rpc");
    expect(snap.planTier).toBe("pro");
    expect(snap.windows).toHaveLength(3);
    expect(snap.windows[0]).toMatchObject({
      label: "5-Hour Window",
      usedPercent: 25,
      remainingPercent: 75,
    });
    expect(snap.windows[1]).toMatchObject({
      label: "Weekly Cap",
      usedPercent: 40,
      remainingPercent: 60,
    });
    expect(snap.windows[2]).toMatchObject({
      label: "Codex Credits",
      remainingAmount: "$18.50",
    });
  });

  it("reads live rate limits, resumes thread, and emits exact usage_delta without double counting", async () => {
    const ch = new MockChannel();
    const engine = new LocalToolEngine({
      sandbox: new WorkspaceSandbox({ workspaceRoot: os.tmpdir(), readOnly: true }),
      policy: new PolicyEngine({ mode: "plan" }),
    });
    const session = new CodexAppServerSession(ch, engine, "local-1");

    const events: Array<Record<string, unknown>> = [];
    session.on("event", (ev) => events.push(ev as Record<string, unknown>));

    ch.on("mock_in", (msg: Record<string, unknown>) => {
      const id = msg.id;
      if (msg.method === "initialize") {
        ch.reply({ jsonrpc: "2.0", id, result: { ok: true } });
      } else if (msg.method === "account/rateLimits/read") {
        ch.reply({
          jsonrpc: "2.0",
          id,
          result: {
            rateLimits: {
              planType: "plus",
              primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1795500000 },
            },
          },
        });
      } else if (msg.method === "thread/resume") {
        ch.reply({ jsonrpc: "2.0", id, result: { thread: { id: "remote-thr-99" } } });
      } else if (msg.method === "turn/start") {
        ch.reply({ jsonrpc: "2.0", id, result: { ok: true } });
        ch.reply({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { delta: "Hello from Codex" },
        });
        ch.reply({
          jsonrpc: "2.0",
          method: "thread/tokenUsage/updated",
          params: {
            tokenUsage: {
              last: {
                inputTokens: 1200,
                outputTokens: 340,
                cachedInputTokens: 600,
                reasoningOutputTokens: 120,
              },
            },
          },
        });
        ch.reply({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { usage: { inputTokens: 1200, outputTokens: 340 } },
        });
      }
    });

    await session.initialize();
    const quota = await session.readRateLimits("us-vps", "us-codex");
    expect(quota.available).toBe(true);
    expect(quota.windows[0]?.remainingPercent).toBe(90);

    const resumed = await session.resumeOrStartThread({ resumeThreadId: "remote-thr-99" });
    expect(resumed).toEqual({ threadId: "remote-thr-99", resumed: true });
    expect(session.getRemoteSessionId()).toBe("remote-thr-99");

    await session.prompt("test");
    const usageEvents = events.filter((e) => e.type === "usage_delta");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 600,
      reasoningTokens: 120,
      exact: true,
    });
  });
});
