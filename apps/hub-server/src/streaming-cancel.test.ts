import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentRemoteHub } from "./hub.js";

/**
 * Fake ACP agent script that supports three modes via prompt text:
 * - "CALL_SUBAGENT": calls local MCP `dispatch_subagent` on `explorer`, waits for its result, then replies.
 * - "HANG_IGNORE_CANCEL": emits a chunk and hangs forever ignoring `session/cancel` (tests hard-cancel recovery).
 * - "SUBAGENT_STREAM": streams thought chunks, a tool_call update, and multiple text chunks with short delays.
 * - default: replies immediately with "NEXT_TURN_OK".
 */
const FAKE_ACP_AGENT = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let mcpUrl = "";
let mcpToken = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    const mcp = (msg.params?.mcpServers || [])[0];
    if (mcp) {
      mcpUrl = mcp.url;
      const auth = (mcp.headers || []).find((h) => h.name === "Authorization");
      mcpToken = auth ? auth.value : "";
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-fake-sess-1" } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "session/cancel") {
    // Intentionally ignored in HANG_IGNORE_CANCEL mode to verify Hub's force-stop grace timer!
    return;
  }
  if (msg.method === "session/prompt") {
    const fullText = msg.params?.prompt?.[0]?.text || "";
    const text = fullText.trim().split(/\\r?\\n/).pop() || "";
    if (text.includes("CALL_SUBAGENT")) {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: mcpToken },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: "dispatch_subagent",
            arguments: { subagent: "explorer", task: "SUBAGENT_STREAM scan repo" },
          },
        }),
      });
      const json = await res.json();
      const out = json?.result?.content?.[0]?.text || "no-sub-out";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Main got: " + out } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (text.includes("SUBAGENT_STREAM")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "Planning scan..." } } },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", title: "grep src/", status: "running" } },
      });
      await new Promise((r) => setTimeout(r, 30));
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Chunk-1 " } } },
      });
      await new Promise((r) => setTimeout(r, 30));
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Chunk-2" } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (text.includes("HANG_IGNORE_CANCEL")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Working forever..." } } },
      });
      // Never resolve session/prompt
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "NEXT_TURN_OK" } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;

describe("Live subagent streaming and guaranteed turn cancellation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("streams subagent stage, thoughts, tool calls, and text chunks live over Hub WS and recovers cleanly from cancel", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-stream-cancel-"));
    dirs.push(tmp);
    const fakeBin = path.join(tmp, "fake-acp.cjs");
    fs.writeFileSync(fakeBin, FAKE_ACP_AGENT, { mode: 0o755 });

    const hub = new AgentRemoteHub({ dbPath: ":memory:" });
    const started = await hub.listen(0, "127.0.0.1");

    const wsEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      wsEvents.push(JSON.parse(raw.toString("utf8")) as { type: string; payload: Record<string, unknown> });
    });

    try {
      hub.store.upsertHost({
        id: "local-test",
        name: "Local Test",
        transport: "local",
        endpoint: "",
        authMode: "none",
        maxSessions: 4,
      });
      hub.store.upsertProfile({
        id: "main-agy",
        name: "Main AGY",
        hostId: "local-test",
        agent: "antigravity",
        remoteBin: fakeBin,
      });
      hub.store.upsertProfile({
        id: "sub-oc",
        name: "Sub OpenCode",
        hostId: "local-test",
        agent: "opencode",
        remoteBin: fakeBin,
      });
      hub.store.upsertBlueprint({
        name: "explorer",
        description: "Explorer",
        systemPrompt: "",
        tools: ["read_file"],
        executionMode: "federated",
        defaultHostId: "local-test",
        defaultProfileId: "sub-oc",
      });

      const thr = await hub.createThread({
        title: "Stream & Cancel Test",
        workspaceRoot: tmp,
        hostId: "local-test",
        profileId: "main-agy",
      });

      // --- 1. Live subagent streaming ---
      await hub.sendPrompt(thr.id, { prompt: "CALL_SUBAGENT" });
      await waitUntil(() => hub.store.getThread(thr.id)?.status === "idle", 8000);

      const statusStages = wsEvents
        .filter((e) => e.type === "subagent_status")
        .map((e) => e.payload.stage);
      expect(statusStages).toEqual(expect.arrayContaining(["spawning", "initializing", "running"]));

      const thoughtChunks = wsEvents
        .filter((e) => e.type === "subagent_stream" && e.payload.stream === "thought")
        .map((e) => e.payload.text);
      expect(thoughtChunks.join("")).toContain("Planning scan...");

      const textChunks = wsEvents
        .filter((e) => e.type === "subagent_stream" && e.payload.stream === "text")
        .map((e) => e.payload.text);
      expect(textChunks).toEqual(["Chunk-1 ", "Chunk-2"]);

      const toolEvents = wsEvents.filter((e) => e.type === "subagent_tool");
      expect(toolEvents.some((e) => e.payload.toolName === "grep src/")).toBe(true);

      const storedAfterSub = hub.store.listEvents(thr.id);
      const completedSub = storedAfterSub.find((e) => e.kind === "subagent_completed");
      expect(completedSub?.payload.ok).toBe(true);
      expect(completedSub?.payload.text).toBe("Chunk-1 Chunk-2");

      // --- 2. Stopping a hanging main model that ignores session/cancel ---
      await hub.sendPrompt(thr.id, { prompt: "HANG_IGNORE_CANCEL" });
      await waitUntil(
        () =>
          hub.store
            .listEvents(thr.id)
            .some((e) => e.kind === "text_delta" && String(e.payload.text).includes("Working forever")),
        5000,
      );

      const cancelRes = await fetch(`${started.url}/api/threads/${thr.id}/cancel`, { method: "POST" });
      expect(cancelRes.status).toBe(200);

      // Must transition back to idle cleanly within grace period (< 3s)
      await waitUntil(() => hub.store.getThread(thr.id)?.status === "idle", 4000);
      const afterCancel = hub.store.listEvents(thr.id);
      expect(afterCancel.some((e) => e.kind === "turn_cancelled")).toBe(true);

      // --- 3. Subsequent turn on same thread works seamlessly after cancellation ---
      await hub.sendPrompt(thr.id, { prompt: "SAY_OK" });
      await waitUntil(() => hub.store.getThread(thr.id)?.status === "idle", 5000);
      const finalEvents = hub.store.listEvents(thr.id);
      expect(
        finalEvents.some(
          (e) => e.kind === "text_delta" && String(e.payload.text).includes("NEXT_TURN_OK"),
        ),
      ).toBe(true);
    } finally {
      ws.close();
      await hub.close();
    }
  }, 15_000);
});

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}
