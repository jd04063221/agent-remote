import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { formatLocalHistoryContext } from "@agent-remote/core";
import { AgentRemoteHub } from "./hub.js";
import { HubStore } from "./store.js";

const FAKE_CODEX_SCRIPT = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const logFile = process.env.FAKE_CODEX_LOG;
const rl = readline.createInterface({ input: process.stdin });
let activeThread = null;
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2), method: msg.method, params: msg.params }) + "\\n");
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
  } else if (msg.method === "model/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { models: [] } }) + "\\n");
  } else if (msg.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1795500000 },
          secondary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1795900000 },
        },
      },
    }) + "\\n");
  } else if (msg.method === "thread/start") {
    activeThread = "codex-remote-" + Math.random().toString(16).slice(2, 8);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: activeThread } } }) + "\\n");
  } else if (msg.method === "thread/resume") {
    activeThread = msg.params.threadId;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: activeThread } } }) + "\\n");
  } else if (msg.method === "turn/start") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "Reply for " + activeThread } }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { last: { inputTokens: 500, outputTokens: 125, cachedInputTokens: 200, reasoningOutputTokens: 50 } } },
    }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} }) + "\\n");
  }
});
`;

describe("Hub persistence, cross-restart resume, incognito mode, exact usage, and live Codex quota", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const d of dirsToClean.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("safely migrates legacy SQLite DB missing remote_session_id and ephemeral_remote columns", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-migrate-"));
    dirsToClean.push(tmp);
    const dbPath = path.join(tmp, "legacy.sqlite");

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        host_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        mode TEXT NOT NULL DEFAULT 'default',
        quota_saver_mode INTEGER NOT NULL DEFAULT 0,
        subagent_overrides_json TEXT NOT NULL DEFAULT '{}',
        usage_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO threads (id, title, workspace_root, worktree_path, branch, host_id, profile_id, created_at, updated_at)
      VALUES ('thr_legacy', 'Old Thread', '/tmp', '/tmp', 'main', 'h1', 'p1', '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const store = new HubStore(dbPath);
    try {
      const t = store.getThread("thr_legacy");
      expect(t?.id).toBe("thr_legacy");
      expect(t?.ephemeralRemote).toBe(false);
      expect(t?.remoteSessionId).toBeUndefined();
      expect(t?.usage.exact).toBe(false);
    } finally {
      store.close();
    }
  });

  it("formats restored local history cleanly", () => {
    const text = formatLocalHistoryContext([
      { kind: "user_message", payload: { text: "What is 2+2?" } },
      { kind: "text_delta", payload: { text: "2+2 is " } },
      { kind: "text_delta", payload: { text: "4." } },
    ]);
    expect(text).toContain("User: What is 2+2?");
    expect(text).toContain("Assistant: 2+2 is 4.");
  });

  it("supports live Codex quota, exact token accounting, cross-restart remote resume, and incognito local fallback", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-hub-persist-"));
    dirsToClean.push(tmp);
    const dbPath = path.join(tmp, "shared.sqlite");
    const fakeBin = path.join(tmp, "fake-codex.cjs");
    const logFile = path.join(tmp, "codex-rpc.jsonl");
    fs.writeFileSync(fakeBin, FAKE_CODEX_SCRIPT, { mode: 0o755 });
    process.env.FAKE_CODEX_LOG = logFile;

    try {
      // --- Instance 1: live Codex quota + turn 1 ---
      const hub1 = new AgentRemoteHub({ dbPath });
      hub1.store.upsertHost({
        id: "local-box",
        name: "Local Test Box",
        transport: "local",
        endpoint: "",
        authMode: "none",
        maxSessions: 4,
      });
      hub1.store.upsertProfile({
        id: "codex-prof",
        name: "Codex Local",
        hostId: "local-box",
        agent: "codex",
        remoteBin: fakeBin,
      });

      const quotaSnap = await hub1.refreshProfileQuota("codex-prof");
      expect(quotaSnap.available).toBe(true);
      expect(quotaSnap.source).toBe("app-server-rpc");
      expect(quotaSnap.planTier).toBe("pro");
      expect(quotaSnap.windows[0]).toMatchObject({
        label: "5-Hour Window",
        remainingPercent: 82,
      });

      // Resumable thread
      const tResumable = await hub1.createThread({
        title: "Resumable Task",
        workspaceRoot: tmp,
        hostId: "local-box",
        profileId: "codex-prof",
        ephemeralRemote: false,
      });
      await hub1.sendPrompt(tResumable.id, { prompt: "Remember codeword ALPHA" });
      await waitForIdle(hub1, tResumable.id);

      const afterTurn1 = hub1.store.getThread(tResumable.id)!;
      expect(afterTurn1.remoteSessionId).toMatch(/^codex-remote-/);
      expect(afterTurn1.usage).toMatchObject({
        mainInputTokens: 500,
        mainOutputTokens: 125,
        mainCachedInputTokens: 200,
        mainReasoningTokens: 50,
        exact: true,
      });

      // Incognito thread
      const tIncognito = await hub1.createThread({
        title: "Incognito Task",
        workspaceRoot: tmp,
        hostId: "local-box",
        profileId: "codex-prof",
        ephemeralRemote: true,
      });
      await hub1.sendPrompt(tIncognito.id, { prompt: "Remember secret BETA" });
      await waitForIdle(hub1, tIncognito.id);
      const incAfter1 = hub1.store.getThread(tIncognito.id)!;
      expect(incAfter1.remoteSessionId).toBeUndefined();

      await hub1.close();

      // --- Instance 2 (simulates Hub restart / shared CLI-Web SQLite) ---
      fs.writeFileSync(logFile, "");
      const hub2 = new AgentRemoteHub({ dbPath });
      try {
        await hub2.sendPrompt(tResumable.id, { prompt: "Continue resumable" });
        await waitForIdle(hub2, tResumable.id);

        await hub2.sendPrompt(tIncognito.id, { prompt: "Continue incognito" });
        await waitForIdle(hub2, tIncognito.id);

        const logs = fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { argv: string[]; method: string; params?: Record<string, unknown> });

        // Resumable thread called thread/resume with exact saved remoteSessionId
        const resumeCall = logs.find((l) => l.method === "thread/resume");
        expect(resumeCall?.params?.threadId).toBe(afterTurn1.remoteSessionId);

        // Incognito thread passed ephemeral=true and injected locally persisted history!
        const incognitoStart = logs.find((l) => l.method === "thread/start");
        expect(incognitoStart?.argv).toContain("ephemeral=true");
        expect(incognitoStart?.params?.ephemeral).toBe(true);
        expect(String(incognitoStart?.params?.developerInstructions ?? "")).toContain(
          "Remember secret BETA",
        );

        // Exact usage accumulated across restart (500+500 = 1000)
        const afterTurn2 = hub2.store.getThread(tResumable.id)!;
        expect(afterTurn2.usage.mainInputTokens).toBe(1000);
        expect(afterTurn2.usage.mainOutputTokens).toBe(250);
      } finally {
        await hub2.close();
      }
    } finally {
      delete process.env.FAKE_CODEX_LOG;
    }
  });
});

async function waitForIdle(hub: AgentRemoteHub, threadId: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const t = hub.store.getThread(threadId);
    if (t && (t.status === "idle" || t.status === "error")) {
      if (t.status === "error") throw new Error("Thread entered error state");
      return;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to become idle`);
}
