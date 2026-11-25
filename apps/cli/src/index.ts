#!/usr/bin/env node
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runAcpStdioBridge } from "@agent-remote/acp-server";
import {
  AgentRemoteHub,
  attachDriverSession,
  buildSpawnSpecForAgent,
} from "@agent-remote/hub-server";
import {
  parseAgyModelsOutput,
  type AgentKind,
  type ThinkingEffort,
} from "@agent-remote/protocol";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
  PolicyEngine,
  WorkspaceSandbox,
} from "@agent-remote/tool-plane";
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
        console.error(
          "Usage: ar acp --endpoint wss://<node>.ts.net/v1/ws [--token ...] [--agent antigravity|opencode]",
        );
        process.exit(1);
      }
      const agent = getFlag("--agent", "antigravity") as "antigravity" | "opencode";
      await runAcpStdioBridge({
        endpoint,
        bearerToken: getFlag("--token", process.env.AGENT_REMOTE_DEV_TOKEN),
        agent,
        remoteBin: getFlag("--remote-bin"),
        defaultModel: getFlag("--model"),
      });
      break;
    }

    case "exec": {
      const endpoint = getFlag("--endpoint");
      const prompt = getFlag("-p") ?? getFlag("--prompt");
      if (!endpoint || !prompt) {
        console.error(
          'Usage: ar exec --endpoint wss://<node>.ts.net/v1/ws -p "<prompt>" [--agent antigravity] [--model ...] [--effort high] [--cwd .] [--output-format text|json]',
        );
        process.exit(1);
      }
      const agent = (getFlag("--agent", "antigravity") as AgentKind);
      const cwd = path.resolve(getFlag("--cwd", process.cwd())!);
      const format = getFlag("--output-format", "text");
      const model = getFlag("--model");
      const effort = getFlag("--effort") as ThinkingEffort | undefined;

      const client = new TailnetDirectClient({
        hostId: "exec",
        endpoint,
        bearerToken: getFlag("--token", process.env.AGENT_REMOTE_DEV_TOKEN),
        autoReconnect: false,
      });
      await client.connect();

      const sessionId = `exec_${crypto.randomBytes(4).toString("hex")}`;
      const engine = new LocalToolEngine({
        sandbox: new WorkspaceSandbox({ workspaceRoot: cwd }),
        policy: new PolicyEngine({ mode: "auto" }),
      });
      const mcp = new McpJsonRpcHandler(engine);

      const built = buildSpawnSpecForAgent({
        sessionId,
        hostId: "exec",
        profileId: agent,
        agent,
        remoteBin: getFlag("--remote-bin"),
        localWorkspaceRoot: cwd,
        model,
        effort,
        nativePlans: [],
      });

      const ch = await client.spawnSession(built.spawn);
      ch.setMcpHandler((req) => mcp.handleRpc(req, { sessionId }));

      const driver = await attachDriverSession({
        agent,
        hostId: "exec",
        profileId: agent,
        sessionId,
        channel: ch,
        toolEngine: engine,
        model,
        effort,
        systemPromptAppend: built.systemPromptAppend,
        developerInstructions: built.developerInstructions,
      });

      let fullText = "";
      driver.onEvent((ev) => {
        if (ev.type === "text_delta" && ev.text) {
          fullText += ev.text;
          if (format === "text") process.stdout.write(ev.text);
        }
      });

      await driver.prompt(prompt, { model, effort });
      if (format === "json") {
        console.log(JSON.stringify({ ok: true, agent, model, effort, text: fullText }, null, 2));
      } else {
        process.stdout.write("\n");
      }
      ch.kill();
      client.close();
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
      console.log(
        `Node: ${ack.hostname} (${ack.os}/${ack.arch}) v${ack.nodeVersion} | RTT: ${rtt}ms | Peer: ${ack.peerUser ?? "n/a"}`,
      );
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
        console.error(
          "Usage: ar models --endpoint wss://<node>.ts.net/v1/ws [--agent antigravity] [--token ...]",
        );
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

    case "quota": {
      const endpoint = getFlag("--endpoint");
      const agent = getFlag("--agent", "antigravity")!;
      if (!endpoint) {
        console.error(
          "Usage: ar quota --endpoint wss://<node>.ts.net/v1/ws [--agent claude|opencode|antigravity] [--token ...]",
        );
        process.exit(1);
      }
      const client = new TailnetDirectClient({
        hostId: "quota",
        endpoint,
        bearerToken: getFlag("--token", process.env.AGENT_REMOTE_DEV_TOKEN),
        autoReconnect: false,
      });
      await client.connect();
      const q = await client.fetchQuota(agent);
      console.log(`Agent: ${q.agent} | Available: ${q.available} | Source: ${q.source}${q.planTier ? ` | Tier: ${q.planTier}` : ""}`);
      for (const w of q.windows) {
        const val =
          w.remainingAmount ??
          (w.remainingPercent !== undefined ? `${w.remainingPercent.toFixed(1)}% remaining` : "n/a");
        console.log(`  - ${w.label}: ${val}${w.resetsAt ? ` (resets ${w.resetsAt})` : ""}`);
      }
      if (q.note) console.log(`Note: ${q.note}`);
      client.close();
      break;
    }

    case "node": {
      const sub = args[1];
      if (sub === "deploy-script") {
        const port = getFlag("--port", "19420")!;
        const auth = getFlag("--auth", "tailscale-serve")!;
        console.log(`#!/usr/bin/env bash
set -euo pipefail
# Run on your remote Tailnet Linux server after copying bin/agent-remote-node to /usr/local/bin/agent-remote-node
cat <<'EOF' | sudo tee /etc/systemd/system/agent-remote-node.service
[Unit]
Description=agent-remote Remote Tailnet Node
After=network-online.target tailscaled.service

[Service]
Type=simple
ExecStart=/usr/local/bin/agent-remote-node --listen 127.0.0.1:${port} --auth-mode ${auth}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now agent-remote-node
${auth === "tailscale-serve" ? `sudo tailscale serve --bg https / http://127.0.0.1:${port}` : "# Listening with tailscaled-whois auth"}
echo "Done! Connect via wss://<your-host>.<your-tailnet>.ts.net/v1/ws"
`);
        break;
      }
      console.error("Usage: ar node deploy-script [--port 19420] [--auth tailscale-serve|tailscaled-whois]");
      process.exit(1);
    }

    default:
      console.log(`agent-remote (ar) v0.1.0

Commands:
  ar ui [--port 3775] [--host 127.0.0.1]       Start Local Hub + t3code-style Web Workbench
  ar hub [--port 3775] [--db <sqlite>]         Start Local Hub Server
  ar exec --endpoint <ws> -p "<prompt>"        Headless remote execution with local tools
  ar acp --endpoint <ws> [options]             Run standard ACP stdio bridge (Zed/JetBrains)
  ar doctor --endpoint <ws> [--token ...]      Probe remote Tailnet node & all 7 CLIs
  ar models --endpoint <ws> [--agent agy]      Fetch live remote model & effort catalog
  ar quota --endpoint <ws> [--agent claude]    Query remote agent remaining quota / balance
  ar node deploy-script [--port 19420]         Generate remote systemd + tailscale serve script
`);
  }
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
