import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AcpRemoteSession,
  buildAntigravitySpawnSpec,
} from "@agent-remote/driver-antigravity";
import { buildOpenCodeSpawnSpec } from "@agent-remote/driver-opencode";
import type {
  AgentKind,
  CatalogSnapshot,
  SpawnSessionPayload,
  ThinkingEffort,
} from "@agent-remote/protocol";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
  PERMISSION_MODES,
  PolicyEngine,
  WorkspaceSandbox,
  type PermissionMode,
} from "@agent-remote/tool-plane";
import { TailnetDirectClient, type RemoteSessionChannel } from "@agent-remote/transport";

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Normalizes an ACP `cwd` parameter which may be a filesystem path or a `file://` URI
 * (common from Zed / JetBrains on Windows, e.g. `file:///C:/Users/dev/repo`).
 */
export function normalizeAcpCwd(rawCwd: unknown, fallback = process.cwd()): string {
  const s = typeof rawCwd === "string" ? rawCwd.trim() : "";
  if (!s) return fallback;
  if (s.startsWith("file://")) {
    try {
      return fileURLToPath(s);
    } catch {
      return fallback;
    }
  }
  return path.resolve(s);
}

export interface AcpUnifiedSessionAdapter {
  onEvent(cb: (ev: { type: string; text?: string }) => void): void;
  prompt(text: string, opts?: { model?: string; effort?: ThinkingEffort }): Promise<unknown>;
  setConfigOption?: (configId: string, value: string) => Promise<unknown>;
  cancel(): void;
  getInitialSessionResult?: () => Record<string, unknown> | undefined;
}

export type AcpCustomDriverFactory = (params: {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  remoteBin?: string;
  defaultModel?: string;
  defaultEffort?: ThinkingEffort;
  client: TailnetDirectClient;
  toolEngine: LocalToolEngine;
  mcpHandler: McpJsonRpcHandler;
}) => Promise<{
  session: AcpUnifiedSessionAdapter;
  initialCatalog?: CatalogSnapshot;
  channel: RemoteSessionChannel;
}>;

export const ACP_PERMISSION_MODES: ReadonlyArray<{
  id: PermissionMode;
  name: string;
  description: string;
}> = [
  { id: "plan", name: "Plan (Read-Only)", description: "Workspace read-only; mutations and commands disabled" },
  { id: "default", name: "Ask (Workspace)", description: "Workspace read allowed; edits, deletes, and commands ask" },
  { id: "accept-edits", name: "Accept Edits", description: "Workspace edits auto-allowed; deletes and commands ask" },
  { id: "auto", name: "Workspace Safe Auto", description: "Workspace edits and read-only inspection commands auto-allowed" },
  { id: "workspace-full", name: "Workspace Full Access", description: "Full read/write/delete/shell/MCP inside workspace sandbox" },
  { id: "full-access", name: "Full Access (Unrestricted)", description: "Unrestricted local paths, shell commands, and MCP" },
];

export interface AcpStdioBridgeOptions {
  endpoint: string;
  bearerToken?: string;
  privateKeyPem?: string;
  agent: AgentKind;
  remoteBin?: string;
  defaultModel?: string;
  defaultEffort?: ThinkingEffort;
  defaultMode?: PermissionMode;
  /** Optional factory enabling all 7 drivers (injected by `ar acp` CLI via `@agent-remote/hub-server`). */
  driverFactory?: AcpCustomDriverFactory;
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
    privateKeyPem: options.privateKeyPem,
  });
  await client.connect();

  const sessions = new Map<
    string,
    {
      adapter: AcpUnifiedSessionAdapter;
      channel: RemoteSessionChannel;
      sandbox: WorkspaceSandbox;
      policy: PolicyEngine;
      model?: string;
      effort?: ThinkingEffort;
    }
  >();

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
        const cwd = normalizeAcpCwd(req.params?.cwd);
        const localSessionId = `acp_${crypto.randomBytes(4).toString("hex")}`;
        const initialMode: PermissionMode =
          options.defaultMode && (PERMISSION_MODES as readonly string[]).includes(options.defaultMode)
            ? options.defaultMode
            : "accept-edits";
        const sandbox = new WorkspaceSandbox({
          workspaceRoot: cwd,
          allowOutsideWorkspace: initialMode === "full-access",
        });
        const policy = new PolicyEngine({ mode: initialMode });
        const engine = new LocalToolEngine({ sandbox, policy });
        const mcpHandler = new McpJsonRpcHandler(engine);

        let adapter: AcpUnifiedSessionAdapter;
        let channel: RemoteSessionChannel;
        let initialResult: Record<string, unknown> = { sessionId: localSessionId };

        if (options.driverFactory) {
          const created = await options.driverFactory({
            agent: options.agent,
            sessionId: localSessionId,
            cwd,
            remoteBin: options.remoteBin,
            defaultModel: options.defaultModel,
            defaultEffort: options.defaultEffort,
            client,
            toolEngine: engine,
            mcpHandler,
          });
          adapter = created.session;
          channel = created.channel;
          const extra = adapter.getInitialSessionResult?.();
          if (extra) initialResult = { ...extra, sessionId: localSessionId };
          else if (created.initialCatalog) {
            initialResult = {
              sessionId: localSessionId,
              models: {
                currentModelId: created.initialCatalog.currentModelId ?? options.defaultModel,
                availableModels: created.initialCatalog.models.map((m) => ({
                  modelId: m.id,
                  name: m.displayName,
                })),
              },
            };
          }
        } else {
          const spawnBuilt: { spawn: SpawnSessionPayload; systemPromptAppend?: string } =
            options.agent === "opencode"
              ? {
                  spawn: buildOpenCodeSpawnSpec({
                    sessionId: localSessionId,
                    remoteBin: options.remoteBin,
                    model: options.defaultModel,
                  }),
                }
              : buildAntigravitySpawnSpec({
                  sessionId: localSessionId,
                  remoteBin: options.remoteBin,
                  localWorkspaceRoot: cwd,
                });

          channel = await client.spawnSession(spawnBuilt.spawn);
          channel.setMcpHandler((rpcReq) =>
            mcpHandler.handleRpc(rpcReq, { sessionId: localSessionId }),
          );

          const remoteAcp = new AcpRemoteSession({
            channel,
            toolEngine: engine,
            sessionId: localSessionId,
            blockRemoteBuiltins: true,
          });
          await remoteAcp.initialize();
          const remoteNew = await remoteAcp.startSession({
            systemPromptAppend: spawnBuilt.systemPromptAppend,
          });
          initialResult = { ...remoteNew, sessionId: localSessionId };
          adapter = {
            onEvent: (cb) => remoteAcp.on("event", cb),
            prompt: (text) => remoteAcp.prompt(text),
            setConfigOption: (cid, val) => remoteAcp.setConfigOption(cid, val),
            cancel: () => remoteAcp.cancel(),
          };
        }

        adapter.onEvent((ev) => {
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

        sessions.set(localSessionId, {
          adapter,
          channel,
          sandbox,
          policy,
          model: options.defaultModel,
          effort: options.defaultEffort,
        });

        writeOut({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            ...initialResult,
            sessionId: localSessionId,
            modes: {
              currentModeId: initialMode,
              availableModes: ACP_PERMISSION_MODES,
            },
          },
        });
        return;
      }

      if (req.method === "session/set_mode") {
        const sid = String(req.params?.sessionId ?? "");
        const sess = sessions.get(sid);
        if (!sess) throw new Error(`Unknown session: ${sid}`);
        const modeId = String(req.params?.modeId ?? "");
        if (!(PERMISSION_MODES as readonly string[]).includes(modeId)) {
          throw new Error(`Invalid permission mode "${modeId}" (valid: ${PERMISSION_MODES.join("|")})`);
        }
        const nextMode = modeId as PermissionMode;
        sess.policy.setMode(nextMode);
        sess.sandbox.setAllowOutsideWorkspace(nextMode === "full-access");
        writeOut({ jsonrpc: "2.0", id: req.id, result: { modeId: nextMode } });
        return;
      }

      if (req.method === "session/set_config_option") {
        const sid = String(req.params?.sessionId ?? "");
        const sess = sessions.get(sid);
        if (!sess) throw new Error(`Unknown session: ${sid}`);
        const configId = String(req.params?.configId ?? "");
        const value = String(req.params?.value ?? "");
        if (configId === "mode") {
          if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
            throw new Error(`Invalid permission mode "${value}" (valid: ${PERMISSION_MODES.join("|")})`);
          }
          const nextMode = value as PermissionMode;
          sess.policy.setMode(nextMode);
          sess.sandbox.setAllowOutsideWorkspace(nextMode === "full-access");
          writeOut({ jsonrpc: "2.0", id: req.id, result: { modeId: nextMode } });
          return;
        }
        if (configId === "model") sess.model = value;
        if (configId === "thought_level") sess.effort = value as ThinkingEffort;
        const res = sess.adapter.setConfigOption
          ? await sess.adapter.setConfigOption(configId, value)
          : { ok: true };
        writeOut({ jsonrpc: "2.0", id: req.id, result: res });
        return;
      }

      if (req.method === "session/prompt") {
        const sid = String(req.params?.sessionId ?? "");
        const sess = sessions.get(sid);
        if (!sess) throw new Error(`Unknown session: ${sid}`);
        const items = (req.params?.prompt ?? []) as Array<{ text?: string }>;
        const text = items.map((i) => i.text ?? "").join("\n");
        const res = await sess.adapter.prompt(text, {
          model: sess.model,
          effort: sess.effort,
        });
        writeOut({
          jsonrpc: "2.0",
          id: req.id,
          result: (res && typeof res === "object" ? res : { stopReason: "end_turn" }),
        });
        return;
      }

      if (req.method === "session/cancel") {
        const sid = String(req.params?.sessionId ?? "");
        sessions.get(sid)?.adapter.cancel();
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
    for (const s of sessions.values()) s.channel.kill();
    client.close();
  });
}
