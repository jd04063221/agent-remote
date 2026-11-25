#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { runAcpStdioBridge } from "@agent-remote/acp-server";
import { AgentRemoteHub } from "@agent-remote/hub-server";
import { parseAgyModelsOutput } from "@agent-remote/protocol";
import { TailnetDirectClient } from "@agent-remote/transport";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function getFlag(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "hub":
    case "ui": {
      const port = Number(getFlag("--port", "3775"));
      const host = getFlag("--host", "127.0.0.1")!;
      const dbPath =
        getFlag("--db") ??
        path.join(os.homedir(), ".config", "agent-remote", "hub.sqlite");
      const webDistDir = path.resolve(import.meta.dirname, "../../web/dist");

      const hub = new AgentRemoteHub({ dbPath, webDistDir });
      const info = await hub.listen(port, host);
      console.log(`agent-remote Hub running at ${info.url}`);
      console.log(`SQLite store: ${dbPath}`);
      console.log(`Open ${info.url} in your browser for the multi-agent workbench.`);

      const shutdown = async () => {
        await hub.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      break;
    }

    case "acp": {
      const endpoint = getFlag("--endpoint");
      if (!endpoint) {
        console.error("Usage: ar acp --endpoint wss://<node>.ts.net/v1/ws [--token ...] [--agent antigravity|opencode]");
        process.exit(1);
      }
      const agent = (getFlag("--agent", "antigravity") as "antigravity" | "opencode");
      await runAcpStdioBridge({
        endpoint,
        bearerToken: getFlag("--token", process.env.AGENT_REMOTE_DEV_TOKEN),
        agent,
        remoteBin: getFlag("--remote-bin"),
        defaultModel: getFlag("--model"),
      });
      break;
    }

    case "doctor": {
      const endpoint = getFlag("--endpoint");
      if (!endpoint) {
        console.error("Usage: ar doctor --endpoint wss://<node>.ts.net/v1/ws [--token ...]");
        process.exit(1);
      }
      const client = new TailnetDirectClient({
        hostId: "doctor",
        endpoint,
        bearerToken: getFlag("--token", process.env.AGENT_REMOTE_DEV_TOKEN),
        autoReconnect: false,
      });
      const ack = await client.connect();
      const rtt = await client.ping();
      const probe = await client.probe();
      console.log(`Node: ${ack.hostname} (${ack.os}/${ack.arch}) v${ack.nodeVersion} | RTT: ${rtt}ms | Peer: ${ack.peerUser ?? "n/a"}`);
      console.log(`Sessions: ${probe.activeSessions}/${probe.maxSessions}`);
      for (const a of probe.agents) {
        console.log(
          `  ${a.installed ? "✓" : "✗"} ${a.agent.padEnd(14)} (${a.binary}) ${a.installed ? a.version || a.binaryPath : "not installed"}`,
        );
      }
      client.close();
      break;
    }

    case "models": {
      const endpoint = getFlag("--endpoint");
      const agent = getFlag("--agent", "antigravity")!;
      if (!endpoint) {
        console.error("Usage: ar models --endpoint wss://<node>.ts.net/v1/ws [--agent antigravity] [--token ...]");
        process.exit(1);
      }
      const client = new TailnetDirectClient({
        hostId: "models",
        endpoint,
        bearerToken: getFlag("--token", process.env.AGENT_REMOTE_DEV_TOKEN),
        autoReconnect: false,
      });
      await client.connect();
      const raw = await client.discoverCatalogRaw(agent);
      if (raw.error && !raw.rawOutput) {
        console.error("Catalog probe failed:", raw.error);
        process.exit(1);
      }
      if (agent === "antigravity") {
        const parsed = parseAgyModelsOutput(raw.rawOutput);
        for (const m of parsed) {
          console.log(
            `${m.id.padEnd(32)} ${m.displayName.padEnd(28)} efforts=[${m.capabilities.supportedEfforts.join(",")}]`,
          );
        }
      } else {
        console.log(raw.rawOutput);
      }
      client.close();
      break;
    }

    default:
      console.log(`agent-remote (ar) v0.1.0

Commands:
  ar ui [--port 3775] [--host 127.0.0.1]       Start Local Hub + t3code-style Web Workbench
  ar hub [--port 3775] [--db <sqlite>]         Start Local Hub Server
  ar acp --endpoint <ws-url> [options]         Run standard ACP stdio bridge (Zed/JetBrains)
  ar doctor --endpoint <ws-url> [--token ...]  Probe remote Tailnet node & installed CLIs
  ar models --endpoint <ws-url> [--agent agy]  Fetch live remote model & effort catalog
`);
  }
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
