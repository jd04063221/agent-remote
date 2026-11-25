import crypto from "node:crypto";
import readline from "node:readline";
import {
  AcpRemoteSession,
  buildAntigravitySpawnSpec,
} from "@agent-remote/driver-antigravity";
import { buildOpenCodeSpawnSpec } from "@agent-remote/driver-opencode";
import type { AgentKind, ThinkingEffort } from "@agent-remote/protocol";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
  PolicyEngine,
  WorkspaceSandbox,
} from "@agent-remote/tool-plane";
import { TailnetDirectClient } from "@agent-remote/transport";

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpStdioBridgeOptions {
  endpoint: string;
  bearerToken?: string;
  agent: Extract<AgentKind, "antigravity" | "opencode">;
  remoteBin?: string;
  defaultModel?: string;
  defaultEffort?: ThinkingEffort;
}

/**
 * Standard ACP v1 JSON-RPC 2.0 stdio server (`ar acp`) that lets Zed, JetBrains, Paseo, or `acpc`
 * drive remote agents over Tailnet Direct while executing all file and shell tools locally.
 */
export async function runAcpStdioBridge(options: AcpStdioBridgeOptions): Promise<void> {
  const client = new TailnetDirectClient({
    hostId: "acp-remote",
    endpoint: options.endpoint,
    bearerToken: options.bearerToken,
  });
  await client.connect();

  const sessions = new Map<string, AcpRemoteSession>();
  const writeOut = (msg: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcReq;
    try {
      req = JSON.parse(trimmed) as JsonRpcReq;
    } catch {
      return;
    }

    try {
      if (req.method === "initialize") {
        writeOut({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "agent-remote", version: "0.1.0" },
            agentCapabilities: { loadSession: false },
          },
        });
        return;
      }

      if (req.method === "session/new") {
        const cwd = String(req.params?.cwd ?? process.cwd());
        const localSessionId = `acp_${crypto.randomBytes(4).toString("hex")}`;
        const sandbox = new WorkspaceSandbox({ workspaceRoot: cwd });
        const policy = new PolicyEngine({ mode: "accept-edits" });
        const engine = new LocalToolEngine({ sandbox, policy });
        const mcpHandler = new McpJsonRpcHandler(engine);

        const spawnBuilt =
          options.agent === "opencode"
            ? {
                spawn: buildOpenCodeSpawnSpec({
                  sessionId: localSessionId,
                  remoteBin: options.remoteBin,
                  model: options.defaultModel,
                }),
                systemPromptAppend: undefined,
              }
            : buildAntigravitySpawnSpec({
                sessionId: localSessionId,
                remoteBin: options.remoteBin,
                localWorkspaceRoot: cwd,
              });

        const ch = await client.spawnSession(spawnBuilt.spawn);
        ch.setMcpHandler((rpcReq) => mcpHandler.handleRpc(rpcReq, { sessionId: localSessionId }));

        const remoteAcp = new AcpRemoteSession({
          channel: ch,
          toolEngine: engine,
          sessionId: localSessionId,
          blockRemoteBuiltins: true,
        });

        remoteAcp.on("event", (ev: { type: string; text?: string }) => {
          if (ev.type === "text_delta" || ev.type === "thought_delta") {
            writeOut({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: localSessionId,
                update: {
                  sessionUpdate:
                    ev.type === "thought_delta" ? "agent_thought_chunk" : "agent_message_chunk",
                  content: { type: "text", text: ev.text ?? "" },
                },
              },
            });
          }
        });

        await remoteAcp.initialize();
        const remoteNew = await remoteAcp.startSession({
          systemPromptAppend: spawnBuilt.systemPromptAppend,
        });
        sessions.set(localSessionId, remoteAcp);

        writeOut({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            ...remoteNew,
            sessionId: localSessionId,
          },
        });
        return;
      }

      if (req.method === "session/set_config_option") {
        const sid = String(req.params?.sessionId ?? "");
        const sess = sessions.get(sid);
        if (!sess) throw new Error(`Unknown session: ${sid}`);
        const res = await sess.setConfigOption(
          String(req.params?.configId ?? ""),
          String(req.params?.value ?? ""),
        );
        writeOut({ jsonrpc: "2.0", id: req.id, result: res });
        return;
      }

      if (req.method === "session/prompt") {
        const sid = String(req.params?.sessionId ?? "");
        const sess = sessions.get(sid);
        if (!sess) throw new Error(`Unknown session: ${sid}`);
        const items = (req.params?.prompt ?? []) as Array<{ text?: string }>;
        const text = items.map((i) => i.text ?? "").join("\n");
        const res = await sess.prompt(text);
        writeOut({ jsonrpc: "2.0", id: req.id, result: res });
        return;
      }

      if (req.method === "session/cancel") {
        const sid = String(req.params?.sessionId ?? "");
        sessions.get(sid)?.cancel();
        return;
      }

      if (req.id !== undefined) {
        writeOut({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
    } catch (err) {
      if (req.id !== undefined) {
        writeOut({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: (err as Error).message },
        });
      }
    }
  });

  rl.on("close", () => {
    client.close();
  });
}
