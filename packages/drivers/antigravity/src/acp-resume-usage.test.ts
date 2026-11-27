import { EventEmitter } from "node:events";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { LocalToolEngine, PolicyEngine, WorkspaceSandbox } from "@agent-remote/tool-plane";
import type { RemoteSessionChannel } from "@agent-remote/transport";
import { AcpRemoteSession } from "./acp-session.js";

class MockAcpChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId = "mock-acp";
  readonly channel = 1;
  readonly workdir = "/tmp/empty";
  writeStdin(data: string): void {
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      this.emit("mock_in", JSON.parse(line));
    }
  }
  setMcpHandler(): void {}
  kill(): void {}
  reply(obj: Record<string, unknown>): void {
    this.emit("stdout", JSON.stringify(obj) + "\n");
  }
}

describe("ACP driver: session/load resume, history replay suppression, and exact usage_delta", () => {
  it("resumes via session/load, suppresses replayed history chunks, and extracts prompt usage", async () => {
    const ch = new MockAcpChannel();
    const engine = new LocalToolEngine({
      sandbox: new WorkspaceSandbox({ workspaceRoot: os.tmpdir(), readOnly: true }),
      policy: new PolicyEngine({ mode: "plan" }),
    });
    const acp = new AcpRemoteSession({ channel: ch, toolEngine: engine, sessionId: "acp-1" });
    const events: Array<Record<string, unknown>> = [];
    acp.on("event", (ev) => events.push(ev as Record<string, unknown>));

    ch.on("mock_in", (msg: Record<string, unknown>) => {
      const id = msg.id;
      if (msg.method === "initialize") {
        ch.reply({ jsonrpc: "2.0", id, result: { agentCapabilities: { loadSession: true } } });
      } else if (msg.method === "session/load") {
        // Simulated replay notification during session/load (must NOT be emitted to local SQLite again)
        ch.reply({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "old replayed msg" } },
          },
        });
        ch.reply({ jsonrpc: "2.0", id, result: { sessionId: "remote-acp-88" } });
      } else if (msg.method === "session/prompt") {
        ch.reply({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "fresh answer" } },
          },
        });
        ch.reply({
          jsonrpc: "2.0",
          id,
          result: {
            stopReason: "end_turn",
            usage: {
              inputTokens: 900,
              outputTokens: 180,
              cachedReadTokens: 300,
              thoughtTokens: 90,
            },
          },
        });
      }
    });

    await acp.initialize();
    const started = await acp.resumeOrStartSession({ resumeSessionId: "remote-acp-88" });
    expect(started.resumed).toBe(true);
    expect(acp.getRemoteSessionId()).toBe("remote-acp-88");
    // Replayed text during session/load was suppressed
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);

    await acp.prompt("continue");
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.text).toBe("fresh answer");

    const usageEvents = events.filter((e) => e.type === "usage_delta");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 900,
      outputTokens: 180,
      cachedInputTokens: 300,
      reasoningTokens: 90,
      exact: true,
    });
  });

  it("falls back cleanly to session/new when loadSession is unsupported", async () => {
    const ch = new MockAcpChannel();
    const engine = new LocalToolEngine({
      sandbox: new WorkspaceSandbox({ workspaceRoot: os.tmpdir(), readOnly: true }),
      policy: new PolicyEngine({ mode: "plan" }),
    });
    const acp = new AcpRemoteSession({ channel: ch, toolEngine: engine, sessionId: "acp-2" });

    ch.on("mock_in", (msg: Record<string, unknown>) => {
      if (msg.method === "initialize") {
        ch.reply({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { loadSession: false } } });
      } else if (msg.method === "session/new") {
        ch.reply({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fresh-acp-2" } });
      }
    });

    await acp.initialize();
    const started = await acp.resumeOrStartSession({ resumeSessionId: "old-id" });
    expect(started.resumed).toBe(false);
    expect(acp.getRemoteSessionId()).toBe("fresh-acp-2");
  });

  it("prefers session/resume over session/load when sessionCapabilities.resume is advertised", async () => {
    const ch = new MockAcpChannel();
    const engine = new LocalToolEngine({
      sandbox: new WorkspaceSandbox({ workspaceRoot: os.tmpdir(), readOnly: true }),
      policy: new PolicyEngine({ mode: "plan" }),
    });
    const acp = new AcpRemoteSession({ channel: ch, toolEngine: engine, sessionId: "acp-3" });
    const called: string[] = [];

    ch.on("mock_in", (msg: Record<string, unknown>) => {
      called.push(String(msg.method));
      if (msg.method === "initialize") {
        ch.reply({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, load: {} },
            },
          },
        });
      } else if (msg.method === "session/resume") {
        ch.reply({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "resumed-conv-77" } });
      }
    });

    await acp.initialize();
    const started = await acp.resumeOrStartSession({ resumeSessionId: "resumed-conv-77" });
    expect(started.resumed).toBe(true);
    expect(acp.getRemoteSessionId()).toBe("resumed-conv-77");
    expect(called).toEqual(["initialize", "session/resume"]);
  });
});
