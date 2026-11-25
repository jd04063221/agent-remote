import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { RemoteSessionChannel } from "@agent-remote/transport";
import { buildClaudeSpawnSpec, ClaudeStreamSession } from "./index.js";

class MockChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId = "mock-claude";
  readonly channel = 1;
  readonly workdir = "/tmp/empty";
  writeStdin(data: string): void {
    this.emit("mock_in", data);
  }
  setMcpHandler(): void {}
  kill(): void {}
}

describe("Claude driver: incognito persistence flag, resume, and exact usage parsing", () => {
  it("passes --no-session-persistence in ephemeralRemote mode and omits --resume", () => {
    const spec = buildClaudeSpawnSpec({
      sessionId: "s1",
      localWorkspaceRoot: "/tmp/repo",
      resumeRemoteSessionId: "old-sess-1",
      ephemeralRemote: true,
    });
    expect(spec.args).toContain("--no-session-persistence");
    expect(spec.args).not.toContain("--resume");
  });

  it("passes --resume when remote session ID is set and ephemeralRemote is false", () => {
    const spec = buildClaudeSpawnSpec({
      sessionId: "s2",
      localWorkspaceRoot: "/tmp/repo",
      resumeRemoteSessionId: "claude-sess-42",
      ephemeralRemote: false,
    });
    expect(spec.args).toContain("--resume");
    expect(spec.args).toContain("claude-sess-42");
    expect(spec.args).not.toContain("--no-session-persistence");
  });

  it("captures remote session_id and parses exact token usage & USD cost from stream-json", async () => {
    const ch = new MockChannel();
    const session = new ClaudeStreamSession(ch, "local-claude");
    const events: Array<Record<string, unknown>> = [];
    let observedSessionId = "";

    session.on("event", (ev) => events.push(ev as Record<string, unknown>));
    session.on("remote_session_id", (id: string) => {
      observedSessionId = id;
    });

    ch.on("mock_in", () => {
      ch.emit(
        "stdout",
        JSON.stringify({
          type: "assistant",
          session_id: "claude-remote-77",
          message: { content: [{ type: "text", text: "Done." }] },
        }) + "\n",
      );
      ch.emit(
        "stdout",
        JSON.stringify({
          type: "result",
          session_id: "claude-remote-77",
          total_cost_usd: 0.0125,
          usage: {
            input_tokens: 1500,
            output_tokens: 250,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 100,
          },
        }) + "\n",
      );
    });

    await session.prompt("hello");
    expect(observedSessionId).toBe("claude-remote-77");
    expect(session.getRemoteSessionId()).toBe("claude-remote-77");

    const usageEv = events.find((e) => e.type === "usage_delta");
    expect(usageEv).toMatchObject({
      inputTokens: 1500,
      outputTokens: 250,
      cachedInputTokens: 900,
      costUsd: 0.0125,
      exact: true,
    });
  });
});
