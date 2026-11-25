import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentRemoteHub } from "./hub.js";

const GO_NODE_BIN = path.resolve(
  import.meta.dirname,
  "../../remote-node/bin/agent-remote-node",
);

/**
 * Simulates the exact real-world cross-host flow:
 * 1. Remote Linux Go `agent-remote-node` runs `agy` (`antigravity`) over Tailnet WSS + Go MCP-over-WSS bridge.
 *    - Remote `agy` reads a local project file (`README.md`) via MCP-over-WSS `read_file`.
 *    - Remote `agy` delegates a subtask to `explorer` via MCP-over-WSS `dispatch_subagent`.
 * 2. Local Hub routes `explorer` to the local `opencode` profile (`opencode-go/deepseek-v4.1-flash`)
 *    via `LocalProcessChannel` + `LocalHttpMcpServer`.
 *    - Local `opencode` verifies `OPENCODE_CONFIG_CONTENT` (model + disabled builtins), tests MCP Streamable-HTTP
 *      `GET /mcp` (405), `initialize`, `notifications/initialized` (202), `tools/list`, and calls `read_file`
 *      on `src/secret.ts` inside the local project workspace!
 *    - Local `opencode` streams thinking + text chunks live back over Hub WS and returns the result to remote `agy`.
 * 3. On Turn 2 of the SAME thread, the user re-routes `explorer` mid-thread back to the remote `agy` host
 *    and verifies dynamic re-routing works immediately without recreating the thread.
 */
const REMOTE_AGY_SIM = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let mcpUrl = "";
let mcpAuth = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function mcpCall(method, params, id) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: mcpAuth },
    body: JSON.stringify(id !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params }),
  });
  if (res.status === 202) return { status: 202 };
  return await res.json();
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
      mcpAuth = auth ? auth.value : "";
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "remote-agy-sess-1" } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "session/prompt") {
    const prompt = msg.params?.prompt?.[0]?.text || "";
    // If acting as a subagent on remote agy itself (Turn 2 dynamic re-route):
    if (prompt.includes("[Delegated Task]")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "REMOTE_AGY_SUBAGENT_OK" } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    // Main remote agy flow:
    // 1. Handshake MCP-over-WSS bridge & list tools
    await mcpCall("initialize", { protocolVersion: "2025-03-26" }, 1);
    await mcpCall("notifications/initialized", {});
    const tools = await mcpCall("tools/list", {}, 2);
    const toolNames = (tools.result?.tools || []).map((t) => t.name);
    if (!toolNames.includes("dispatch_subagent") || !toolNames.includes("read_file")) {
      throw new Error("Missing expected MCP tools: " + JSON.stringify(toolNames));
    }

    // 2. Read local project README.md from remote VPS via MCP-over-WSS
    const readmeRes = await mcpCall("tools/call", { name: "read_file", arguments: { path: "README.md" } }, 3);
    const readmeText = readmeRes.result?.content?.[0]?.text || "";

    // 3. Dispatch explorer subagent
    const subRes = await mcpCall(
      "tools/call",
      {
        name: "dispatch_subagent",
        arguments: { subagent: "explorer", task: "Inspect src/secret.ts and report its exported token" },
      },
      4,
    );
    const subText = subRes.result?.content?.[0]?.text || "";

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "README_OK=" + readmeText.includes("LOCAL_PROJECT_MARKER") + " | SUB=" + subText },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;

const LOCAL_OPENCODE_SIM = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let mcpUrl = "";
let mcpAuth = "";
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");

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
      mcpAuth = auth ? auth.value : "";
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "local-opencode-sess-1" } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    // Simulate OpenCode ACP rejecting session/set_config_option in favor of session/set_model
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "session/prompt") {
    const promptText = msg.params?.prompt?.[0]?.text || "";

    // Verify Streamable-HTTP GET /mcp returns 405 (not 400)
    const getRes = await fetch(mcpUrl, { method: "GET", headers: { Authorization: mcpAuth } });
    if (getRes.status !== 405) {
      throw new Error("Expected GET /mcp -> 405, got " + getRes.status);
    }

    // Verify notification returns 202
    const notifRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: mcpAuth },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    if (notifRes.status !== 202) {
      throw new Error("Expected notifications/initialized -> 202, got " + notifRes.status);
    }

    // Read local project file src/secret.ts via LocalHttpMcpServer
    const readRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: mcpAuth },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "src/secret.ts" } },
      }),
    });
    const readJson = await readRes.json();
    const fileContent = readJson.result?.content?.[0]?.text || "";

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "Reading src/secret.ts locally..." } } },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            text:
              "LOCAL_OPENCODE_MODEL=" +
              cfg.model +
              " | HAS_ROLE=" +
              promptText.includes("[Subagent Role: explorer]") +
              " | HAS_WORKSPACE=" +
              promptText.includes("[Workspace Context]") +
              " | FILE_OK=" +
              fileContent.includes("ALPHA_999"),
          },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;

describe("Cross-host end-to-end simulation: Remote Tailnet agy -> Local OpenCode subagent", () => {
  let nodeProc: ChildProcess | undefined;
  let hub: AgentRemoteHub;
  let hubPort = 0;
  let tmpDir = "";
  const nodePort = 19496;
  const devToken = "cross-host-sim-token";

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-cross-host-sim-"));
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Demo\nLOCAL_PROJECT_MARKER\n");
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "secret.ts"), "export const SECRET = 'ALPHA_999';\n");

    if (fs.existsSync(GO_NODE_BIN)) {
      nodeProc = spawn(
        GO_NODE_BIN,
        ["--listen", `127.0.0.1:${nodePort}`, "--auth-mode", "dev-token", "--dev-token", devToken],
        { stdio: "ignore" },
      );
      await new Promise((r) => setTimeout(r, 350));
    }

    hub = new AgentRemoteHub({ dbPath: ":memory:" });
    const started = await hub.listen(0, "127.0.0.1");
    hubPort = started.port;
  });

  afterAll(async () => {
    await hub.close();
    nodeProc?.kill("SIGTERM");
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads local project from remote Tailnet agy, offloads explorer to local OpenCode with live streaming, and re-routes dynamically on Turn 2", async () => {
    if (!nodeProc) return;

    const remoteAgyBin = path.join(tmpDir, "fake-remote-agy.cjs");
    const localOpencodeBin = path.join(tmpDir, "fake-local-opencode.cjs");
    fs.writeFileSync(remoteAgyBin, REMOTE_AGY_SIM, { mode: 0o755 });
    fs.writeFileSync(localOpencodeBin, LOCAL_OPENCODE_SIM, { mode: 0o755 });

    // Host 1: Remote Tailnet Go node with agy
    hub.store.upsertHost({
      id: "remote-vps",
      name: "Remote Tailnet VPS",
      transport: "tailnet-direct",
      endpoint: `ws://127.0.0.1:${nodePort}/v1/ws`,
      authMode: "dev-token",
      bearerToken: devToken,
      maxSessions: 8,
    });
    hub.store.upsertProfile({
      id: "remote-agy",
      name: "Antigravity @ Remote",
      hostId: "remote-vps",
      agent: "antigravity",
      remoteBin: remoteAgyBin,
    });

    // Host 2: Local machine with OpenCode
    hub.store.upsertHost({
      id: "local-pc",
      name: "Local PC",
      transport: "local",
      endpoint: "",
      authMode: "none",
      maxSessions: 4,
    });
    hub.store.upsertProfile({
      id: "local-opencode",
      name: "OpenCode @ Local",
      hostId: "local-pc",
      agent: "opencode",
      remoteBin: localOpencodeBin,
    });

    // Configure explorer blueprint to offload to local OpenCode's real authenticated model
    hub.store.upsertBlueprint({
      name: "explorer",
      description: "Scan local repo via local OpenCode",
      systemPrompt: "Locate files quickly and report exact symbols.",
      tools: ["read_file", "grep", "glob", "list_dir"],
      executionMode: "auto",
      defaultHostId: "local-pc",
      defaultProfileId: "local-opencode",
      defaultModel: "opencode-go/deepseek-v4.1-flash",
    });

    const wsMsgs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      wsMsgs.push(JSON.parse(raw.toString("utf8")) as { type: string; payload: Record<string, unknown> });
    });

    try {
      const thr = await hub.createThread({
        title: "Cross-Host Simulation",
        workspaceRoot: tmpDir,
        hostId: "remote-vps",
        profileId: "remote-agy",
        model: "gemini-4-neon",
        effort: "high",
        quotaSaverMode: true,
      });

      // Turn 1: Remote agy reads local README.md + delegates explorer to Local OpenCode
      await hub.sendPrompt(thr.id, { prompt: "Analyze this project" });
      await waitUntil(() => hub.store.getThread(thr.id)?.status === "idle", 12_000);

      const turn1Events = hub.store.listEvents(thr.id);
      const mainReplies1 = turn1Events
        .filter((e) => e.kind === "text_delta")
        .map((e) => String(e.payload.text ?? ""))
        .join("");

      expect(mainReplies1).toContain("README_OK=true");
      expect(mainReplies1).toContain("LOCAL_OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash");
      expect(mainReplies1).toContain("HAS_ROLE=true");
      expect(mainReplies1).toContain("HAS_WORKSPACE=true");
      expect(mainReplies1).toContain("FILE_OK=true");

      // Verify live streaming WS events from local OpenCode subagent arrived
      expect(
        wsMsgs.some(
          (m) =>
            m.type === "subagent_stream" &&
            m.payload.stream === "thought" &&
            String(m.payload.text).includes("Reading src/secret.ts locally"),
        ),
      ).toBe(true);
      expect(
        wsMsgs.some(
          (m) =>
            m.type === "subagent_tool" &&
            m.payload.toolName === "read_file" &&
            String(m.payload.summary).includes("src/secret.ts"),
        ),
      ).toBe(true);

      // Turn 2 (SAME thread!): dynamically switch explorer override to run on remote-agy instead of local-opencode
      await hub.sendPrompt(thr.id, {
        prompt: "Now run explorer on main host",
        subagents: {
          explorer: {
            enabled: true,
            hostId: "remote-vps",
            profileId: "remote-agy",
            model: "gemini-4-neon",
          },
        },
      });
      await waitUntil(
        () =>
          hub.store.getThread(thr.id)?.status === "idle" &&
          hub.store
            .listEvents(thr.id)
            .filter((e) => e.kind === "turn_completed").length >= 2,
        12_000,
      );

      const turn2Replies = hub.store
        .listEvents(thr.id)
        .filter((e) => e.kind === "text_delta")
        .map((e) => String(e.payload.text ?? ""))
        .join("");
      expect(turn2Replies).toContain("REMOTE_AGY_SUBAGENT_OK");
    } finally {
      ws.close();
    }
  }, 20_000);
});

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
