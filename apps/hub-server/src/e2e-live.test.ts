import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AcpRemoteSession,
  buildAntigravitySpawnSpec,
} from "@agent-remote/driver-antigravity";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
  PolicyEngine,
  WorkspaceSandbox,
} from "@agent-remote/tool-plane";
import { TailnetDirectClient } from "@agent-remote/transport";
import { AgentRemoteHub } from "./hub.js";

const GO_NODE_BIN = path.resolve(
  import.meta.dirname,
  "../../remote-node/bin/agent-remote-node",
);

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Live E2E: Hub + Worktree + Go remote-node + real agy acp over WSS", () => {
  let nodeProc: ChildProcess | undefined;
  let hub: AgentRemoteHub;
  let hubUrl: string;
  let tmpRepo: string;
  const nodePort = 19499;
  const devToken = "e2e-live-token";

  beforeAll(async () => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ar-e2e-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "e2e"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "e2e@local"], { cwd: tmpRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "sample.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo, stdio: "ignore" });

    if (fs.existsSync(GO_NODE_BIN)) {
      nodeProc = spawn(
        GO_NODE_BIN,
        [
          "--listen",
          `127.0.0.1:${nodePort}`,
          "--auth-mode",
          "dev-token",
          "--dev-token",
          devToken,
        ],
        { stdio: "ignore" },
      );
      await new Promise((r) => setTimeout(r, 350));
    }

    hub = new AgentRemoteHub({ dbPath: ":memory:" });
    const started = await hub.listen(0, "127.0.0.1");
    hubUrl = started.url;
  });

  afterAll(async () => {
    await hub.close();
    nodeProc?.kill("SIGTERM");
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("creates isolated Git Worktree thread, refreshes live agy models/quota, and runs live agy acp over Go WSS", async () => {
    if (!nodeProc || !hasBinary("agy")) {
      return;
    }

    // 1. Register host & profile
    await fetch(`${hubUrl}/api/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "live-node",
        name: "Live Go Tailnet Node",
        transport: "tailnet-direct",
        endpoint: `ws://127.0.0.1:${nodePort}/v1/ws`,
        authMode: "dev-token",
        bearerToken: devToken,
        maxSessions: 8,
      }),
    });

    await fetch(`${hubUrl}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "live-agy",
        name: "Live AGY",
        hostId: "live-node",
        agent: "antigravity",
        remoteBin: "agy",
        defaultEffort: "high",
      }),
    });

    // 2. Refresh live agy model catalog through Go remote-node
    const modRes = await fetch(`${hubUrl}/api/profiles/live-agy/refresh-models`, {
      method: "POST",
    });
    expect(modRes.status).toBe(200);
    const modBody = (await modRes.json()) as {
      snapshot: { models: Array<{ id: string; capabilities: { supportedEfforts: string[] } }> };
    };
    const neon = modBody.snapshot.models.find((m) => m.id === "gemini-4-neon");
    expect(neon).toBeDefined();
    expect(neon?.capabilities.supportedEfforts).toContain("xhigh");

    // 3. Refresh remote quota through Go remote-node
    const qRes = await fetch(`${hubUrl}/api/profiles/live-agy/refresh-quota`, {
      method: "POST",
    });
    expect(qRes.status).toBe(200);

    // 4. Create isolated Git Worktree thread
    const thrRes = await fetch(`${hubUrl}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "E2E Worktree Test",
        workspaceRoot: tmpRepo,
        hostId: "live-node",
        profileId: "live-agy",
        createWorktree: true,
        branchName: "feat/e2e-wt",
        quotaSaverMode: true,
      }),
    });
    expect(thrRes.status).toBe(200);
    const thrBody = (await thrRes.json()) as {
      thread: { id: string; worktreePath: string; branch: string };
    };
    expect(thrBody.thread.branch).toBe("feat/e2e-wt");
    expect(fs.existsSync(thrBody.thread.worktreePath)).toBe(true);

    // 5. Live agy acp handshake + session/new + hot config switch over Go WSS multiplexer
    const client = new TailnetDirectClient({
      hostId: "live-node",
      endpoint: `ws://127.0.0.1:${nodePort}/v1/ws`,
      bearerToken: devToken,
      autoReconnect: false,
    });
    await client.connect();

    const engine = new LocalToolEngine({
      sandbox: new WorkspaceSandbox({ workspaceRoot: thrBody.thread.worktreePath }),
      policy: new PolicyEngine({ mode: "auto" }),
    });
    const mcp = new McpJsonRpcHandler(engine);
    const built = buildAntigravitySpawnSpec({
      sessionId: "e2e-agy-acp-1",
      localWorkspaceRoot: thrBody.thread.worktreePath,
      localGitBranch: thrBody.thread.branch,
    });

    const ch = await client.spawnSession(built.spawn);
    ch.setMcpHandler((req) => mcp.handleRpc(req, { sessionId: "e2e-agy-acp-1" }));

    const acp = new AcpRemoteSession({
      channel: ch,
      toolEngine: engine,
      sessionId: "e2e-agy-acp-1",
      blockRemoteBuiltins: true,
    });

    try {
      await acp.initialize();
      const sessNew = await acp.startSession({ systemPromptAppend: built.systemPromptAppend });
      expect(sessNew.sessionId).toBeTruthy();
      const snap = acp.extractCatalogSnapshot("live-node", "live-agy", "antigravity", sessNew);
      expect(snap.models.length).toBeGreaterThan(3);
      expect(snap.tierName).toBeTruthy();

      // Hot-switch thinking level over live ACP session
      await acp.setConfigOption("thought_level", "low");
    } finally {
      ch.kill();
      client.close();
    }
  }, 45_000);
});
