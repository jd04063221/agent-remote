import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRemoteHub } from "./hub.js";

const GO_NODE_BIN = path.resolve(
  import.meta.dirname,
  "../../remote-node/bin/agent-remote-node",
);

describe("AgentRemoteHub + Go remote-node live integration", () => {
  let nodeProc: ChildProcess | undefined;
  let hub: AgentRemoteHub;
  let hubUrl: string;
  const nodePort = 19491;
  const devToken = "hub-integration-secret";

  beforeAll(async () => {
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
  });

  it("manages hosts, profiles, subagent blueprints, and connects to real Go remote-node", async () => {
    // 1. Register host & profile via REST API
    const hostRes = await fetch(`${hubUrl}/api/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "test-vps",
        name: "Test Tailnet Node",
        transport: "tailnet-direct",
        endpoint: `ws://127.0.0.1:${nodePort}/v1/ws`,
        authMode: "dev-token",
        bearerToken: devToken,
        maxSessions: 6,
      }),
    });
    expect(hostRes.status).toBe(200);

    const profRes = await fetch(`${hubUrl}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "test-agy",
        name: "Antigravity @ Test Node",
        hostId: "test-vps",
        agent: "antigravity",
        remoteBin: "agy",
        defaultEffort: "high",
      }),
    });
    expect(profRes.status).toBe(200);

    // 2. Verify default blueprints seeded
    const stateRes = await fetch(`${hubUrl}/api/state`);
    const state = (await stateRes.json()) as {
      hosts: Array<{ id: string }>;
      profiles: Array<{ id: string }>;
      blueprints: Array<{ name: string }>;
    };
    expect(state.hosts.some((h) => h.id === "test-vps")).toBe(true);
    expect(state.profiles.some((p) => p.id === "test-agy")).toBe(true);
    expect(state.blueprints.map((b) => b.name)).toContain("explorer");

    // 3. Connect & probe live Go remote-node if built
    if (nodeProc) {
      const probeRes = await fetch(`${hubUrl}/api/hosts/test-vps/probe`, { method: "POST" });
      expect(probeRes.status).toBe(200);
      const probeBody = (await probeRes.json()) as {
        ok: boolean;
        probe: { agents: Array<{ agent: string; installed: boolean }> };
        state: { hosts: Array<{ id: string; connected: boolean; rttMs?: number }> };
      };
      expect(probeBody.ok).toBe(true);
      expect(probeBody.probe.agents.some((a) => a.agent === "antigravity")).toBe(true);
      const liveHost = probeBody.state.hosts.find((h) => h.id === "test-vps");
      expect(liveHost?.connected).toBe(true);
      expect(typeof liveHost?.rttMs).toBe("number");
    }

    // 4. Normalizes endpoint URL, surfaces error on bad token, evicts stale client on edit, and cascades on delete
    const badHostRes = await fetch(`${hubUrl}/api/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "edit-vps",
        name: "Editable Node",
        transport: "tailnet-direct",
        endpoint: `http://127.0.0.1:${nodePort}/healthz`,
        authMode: "dev-token",
        bearerToken: "wrong-token",
        maxSessions: 4,
      }),
    });
    expect(badHostRes.status).toBe(200);
    const badHostJson = (await badHostRes.json()) as { host: { endpoint: string } };
    expect(badHostJson.host.endpoint).toBe(`ws://127.0.0.1:${nodePort}/v1/ws`);

    await fetch(`${hubUrl}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "edit-prof",
        name: "Temp Profile",
        hostId: "edit-vps",
        agent: "antigravity",
      }),
    });

    if (nodeProc) {
      const failProbe = await fetch(`${hubUrl}/api/hosts/edit-vps/probe`, { method: "POST" });
      expect(failProbe.status).toBe(500);
      const errState = (await (await fetch(`${hubUrl}/api/state`)).json()) as {
        hosts: Array<{ id: string; connected: boolean; lastError?: string }>;
      };
      const failingHost = errState.hosts.find((h) => h.id === "edit-vps");
      expect(failingHost?.connected).toBe(false);
      expect(failingHost?.lastError).toMatch(/HTTP 401/);

      // Edit host with correct token -> stale client evicted, probe succeeds & clears lastError
      const fixRes = await fetch(`${hubUrl}/api/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "edit-vps",
          name: "Editable Node",
          transport: "tailnet-direct",
          endpoint: `http://127.0.0.1:${nodePort}`,
          authMode: "dev-token",
          bearerToken: devToken,
          maxSessions: 4,
        }),
      });
      expect(fixRes.status).toBe(200);
      const fixedProbe = await fetch(`${hubUrl}/api/hosts/edit-vps/probe`, { method: "POST" });
      expect(fixedProbe.status).toBe(200);
      const fixedJson = (await fixedProbe.json()) as {
        state: { hosts: Array<{ id: string; connected: boolean; lastError?: string }> };
      };
      const okHost = fixedJson.state.hosts.find((h) => h.id === "edit-vps");
      expect(okHost?.connected).toBe(true);
      expect(okHost?.lastError).toBeUndefined();
    }

    // Delete host cascades its profiles
    const delRes = await fetch(`${hubUrl}/api/hosts/edit-vps`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const afterDel = (await delRes.json()) as {
      ok: boolean;
      state: { hosts: Array<{ id: string }>; profiles: Array<{ id: string }> };
    };
    expect(afterDel.state.hosts.some((h) => h.id === "edit-vps")).toBe(false);
    expect(afterDel.state.profiles.some((p) => p.id === "edit-prof")).toBe(false);
  });
});
