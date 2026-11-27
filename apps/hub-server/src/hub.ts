import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import {
  buildQuotaSaverGuidance,
  formatLocalHistoryContext,
  loadAgentRemoteConfig,
  parsePermissionRuleExpr,
  resolveEffortForModel,
  type AgentRemoteConfig,
} from "@agent-remote/core";
import { AcpRemoteSession } from "@agent-remote/driver-antigravity";
import { getClaudeFallbackModels } from "@agent-remote/driver-claude";
import { parseFactoryCustomModelsJson } from "@agent-remote/driver-factory-droid";
import { parseKiroModelsOutput } from "@agent-remote/driver-kiro";
import {
  parseAgyModelsOutput,
  type CatalogSnapshot,
  type QuotaSnapshot,
  type SubagentBlueprint,
  type SubagentTaskOverride,
  type ThinkingEffort,
} from "@agent-remote/protocol";
import {
  registerFederatedSubagentTools,
  resolveSubagentPlans,
  type FederatedSubagentCall,
  type FederatedSubagentResult,
} from "@agent-remote/subagent-orchestrator";
import {
  LocalHttpMcpServer,
  LocalToolEngine,
  McpJsonRpcHandler,
  mountLocalMcpServers,
  PolicyEngine,
  WorkspaceSandbox,
  WorktreeManager,
  type ApprovalOutcome,
  type ApprovalRequest,
  type PermissionMode,
  type PolicyRule,
  type StdioMcpClient,
} from "@agent-remote/tool-plane";
import {
  deriveEd25519PublicKey,
  generateApiKey,
  generateEd25519Keypair,
  LocalProcessChannel,
  normalizeTailnetEndpoint,
  SshSessionChannel,
  TailnetDirectClient,
  type NodeProbeResult,
  type RemoteSessionChannel,
} from "@agent-remote/transport";

import {
  attachDriverSession,
  buildSpawnSpecForAgent,
  probeCodexRateLimitsOverChannel,
  type UnifiedDriverSession,
} from "./driver-factory.js";
import {
  HubStore,
  type HostRecord,
  type ProfileRecord,
  type ThreadRecord,
} from "./store.js";

class TurnCancelledError extends Error {
  constructor() {
    super("Turn cancelled by user");
    this.name = "TurnCancelledError";
  }
}

interface ActiveChildHandle {
  childId: string;
  cancel: () => void;
  forceKill: () => void;
}

interface ActiveTurn {
  turnId: string;
  abortController: AbortController;
  cancelled: boolean;
  children: Map<string, ActiveChildHandle>;
  forceFinish?: () => void;
  graceTimer?: NodeJS.Timeout;
}

interface ActiveRuntime {
  threadId: string;
  profileId: string;
  hostId: string;
  channel: RemoteSessionChannel;
  driver: UnifiedDriverSession;
  engine: LocalToolEngine;
  policy: PolicyEngine;
  abortController: AbortController;
  localMcpClients: StdioMcpClient[];
  localHttpMcp?: LocalHttpMcpServer;
  pendingHistoryPrefix?: string;
  lastDelegationGuidance?: string;
  turnReceivedExactUsage: boolean;
  turnEstimatedOutputTokens: number;
}

export interface HubServerOptions {
  port?: number;
  host?: string;
  dbPath: string;
  webDistDir?: string;
  configPath?: string;
}

function resolveHubAppVersion(): string {
  const fromEnv = process.env.AGENT_REMOTE_VERSION?.trim();
  if (fromEnv) return fromEnv.replace(/^v/i, "");
  const candidates = [
    path.resolve(import.meta.dirname, "../../cli/package.json"),
    path.resolve(import.meta.dirname, "../../desktop/package.json"),
    path.resolve(import.meta.dirname, "../package.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version?.trim()) return pkg.version.trim().replace(/^v/i, "");
    } catch {
      // try next candidate
    }
  }
  return "0.1.4";
}

export class AgentRemoteHub {
  readonly store: HubStore;
  readonly config: AgentRemoteConfig;
  private readonly webDistDir?: string;
  private readonly appVersion: string;

  private readonly clients = new Map<string, TailnetDirectClient>();
  private readonly probeCache = new Map<string, NodeProbeResult>();
  private readonly hostErrors = new Map<string, string>();
  private readonly runtimes = new Map<string, ActiveRuntime>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingApprovals = new Map<
    string,
    { threadId: string; request: ApprovalRequest; resolve: (o: ApprovalOutcome) => void }
  >();
  private readonly uiSockets = new Set<WebSocket>();

  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private closed = false;

  constructor(options: { dbPath: string; webDistDir?: string; configPath?: string }) {
    this.store = new HubStore(options.dbPath);
    this.webDistDir = options.webDistDir;
    this.appVersion = resolveHubAppVersion();
    this.config = loadAgentRemoteConfig({ globalPath: options.configPath });
    this.hydrateFromConfig(this.config);
  }

  private hydrateFromConfig(cfg: AgentRemoteConfig): void {
    for (const [id, h] of Object.entries(cfg.hosts)) {
      if (!this.store.getHost(id)) {
        let privateKeyPem = h.private_key_pem?.trim() || undefined;
        let publicKey = h.public_key?.trim() || undefined;
        if (!privateKeyPem && h.private_key_path?.trim()) {
          try {
            privateKeyPem = fs.readFileSync(h.private_key_path.trim(), "utf8");
          } catch {
            // ignore missing key file on startup
          }
        }
        if (privateKeyPem) {
          try {
            const derived = deriveEd25519PublicKey(privateKeyPem, h.name ?? id);
            privateKeyPem = derived.privateKeyPem;
            publicKey = publicKey || derived.publicKey;
          } catch {
            // keep raw config value if unparseable
          }
        }
        this.store.upsertHost({
          id,
          name: h.name ?? id,
          transport: h.transport,
          endpoint:
            h.transport === "tailnet-direct" ? normalizeTailnetEndpoint(h.endpoint) : h.endpoint,
          authMode: h.auth,
          bearerToken: h.bearer_token,
          privateKeyPem,
          publicKey,
          sshTarget: h.ssh_target,
          maxSessions: h.max_concurrent_sessions,
        });
      }
    }
    for (const [id, p] of Object.entries(cfg.profiles)) {
      if (!this.store.getProfile(id)) {
        this.store.upsertProfile({
          id,
          name: p.name ?? id,
          hostId: p.host,
          agent: p.agent,
          remoteBin: p.remote_bin,
          defaultModel: p.default_model,
          defaultEffort: p.default_effort,
        });
      }
    }
    for (const [name, s] of Object.entries(cfg.subagents)) {
      this.store.upsertBlueprint({
        name,
        description: s.description,
        systemPrompt: s.system_prompt,
        tools: s.tools,
        executionMode: s.execution_mode,
        defaultHostId: s.default_host,
        defaultProfileId: s.default_profile,
        defaultModel: s.default_model,
        defaultEffort: s.default_effort,
      });
    }
  }

  private buildConfiguredPolicyRules(): PolicyRule[] {
    const rules: PolicyRule[] = [];
    for (const expr of this.config.permissions.deny) {
      const r = parsePermissionRuleExpr(expr, "deny");
      if (r) rules.push(r);
    }
    for (const expr of this.config.permissions.ask) {
      const r = parsePermissionRuleExpr(expr, "ask");
      if (r) rules.push(r);
    }
    for (const expr of this.config.permissions.allow) {
      const r = parsePermissionRuleExpr(expr, "allow");
      if (r) rules.push(r);
    }
    return rules;
  }

  async listen(port = 3775, host = "127.0.0.1"): Promise<{ url: string; port: number }> {
    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    } catch (err) {
      try {
        server.close();
      } catch {
        // ignore cleanup error
      }
      throw err;
    }

    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("error", () => {
      // Prevent late socket/server errors from crashing the Hub process
    });
    wss.on("connection", (ws) => {
      this.uiSockets.add(ws);
      ws.send(JSON.stringify({ type: "state_snapshot", payload: this.getFullState() }));
      ws.on("close", () => this.uiSockets.delete(ws));
    });

    this.httpServer = server;
    this.wss = wss;
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return { url: `http://${host}:${actualPort}`, port: actualPort };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [tid, turn] of this.activeTurns.entries()) {
      turn.cancelled = true;
      if (turn.graceTimer) clearTimeout(turn.graceTimer);
      turn.abortController.abort();
      for (const child of turn.children.values()) {
        try {
          child.forceKill();
        } catch {
          // ignore
        }
      }
      turn.forceFinish?.();
      this.activeTurns.delete(tid);
    }
    for (const rt of this.runtimes.values()) {
      rt.abortController.abort();
      try {
        rt.channel.kill();
      } catch {
        // ignore
      }
      for (const c of rt.localMcpClients) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
      try {
        await rt.localHttpMcp?.close();
      } catch {
        // ignore
      }
    }
    this.runtimes.clear();

    for (const ws of this.uiSockets) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.uiSockets.clear();
    try {
      this.wss?.close();
    } catch {
      // ignore
    }
    this.wss = undefined;

    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = undefined;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 1_500);
        timer.unref?.();
        try {
          server.close(finish);
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          server.unref?.();
        } catch {
          finish();
        }
      });
    }

    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    try {
      this.store.close();
    } catch {
      // ignore
    }
  }

  getFullState() {
    const hosts = this.store.listHosts().map((h) => {
      const client = this.clients.get(h.id);
      const status = client?.getStatus();
      return {
        ...h,
        bearerToken: h.bearerToken ? "***" : undefined,
        hasBearerToken: Boolean(h.bearerToken),
        privateKeyPem: undefined,
        hasPrivateKey: Boolean(h.privateKeyPem),
        publicKey: h.publicKey,
        connected: h.transport === "local" ? true : (client?.isConnected() ?? false),
        rttMs: status?.rttMs,
        peerUser: status?.node?.peerUser,
        activeSessions: status?.activeSessions ?? 0,
        probe: this.probeCache.get(h.id),
        lastError: this.hostErrors.get(h.id),
      };
    });

    return {
      localEnv: {
        version: this.appVersion,
        defaultWorkspaceRoot: process.cwd(),
        platform: process.platform,
        arch: process.arch,
      },
      hosts,
      profiles: this.store.listProfiles(),
      catalogs: this.store.listCatalogs(),
      quotas: this.store.listQuotas(),
      blueprints: this.store.listBlueprints(),
      threads: this.store.listThreads(),
      pendingApprovals: Array.from(this.pendingApprovals.values()).map((a) => a.request),
    };
  }

  async connectHost(hostId: string): Promise<NodeProbeResult | null> {
    const host = this.store.getHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);

    if (host.transport === "local") {
      this.hostErrors.delete(hostId);
      this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      return null;
    }

    if (host.transport === "tailscale-ssh" || host.transport === "openssh") {
      if (!host.sshTarget?.trim()) {
        const err = new Error(`Host "${host.id}" (${host.transport}) requires an SSH target`);
        this.hostErrors.set(hostId, err.message);
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
        throw err;
      }
      this.hostErrors.delete(hostId);
      this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      return null;
    }

    const normalizedEndpoint = normalizeTailnetEndpoint(host.endpoint);
    if (!normalizedEndpoint) {
      const err = new Error(`Host "${host.id}" requires an endpoint URL (e.g. wss://<host>.ts.net/v1/ws)`);
      this.hostErrors.set(hostId, err.message);
      this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      throw err;
    }

    let client = this.clients.get(hostId);
    if (client && client.endpoint !== normalizedEndpoint) {
      client.close();
      this.clients.delete(hostId);
      client = undefined;
    }

    if (!client) {
      client = new TailnetDirectClient({
        hostId: host.id,
        endpoint: normalizedEndpoint,
        bearerToken: host.authMode === "dev-token" ? host.bearerToken : undefined,
        privateKeyPem: host.authMode === "pubkey" ? host.privateKeyPem : undefined,
      });
      client.on("connected", () => {
        this.hostErrors.delete(hostId);
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      });
      client.on("disconnected", () => {
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      });
      this.clients.set(hostId, client);
    }

    try {
      if (!client.isConnected()) {
        await client.connect();
      }
      await client.ping();
      const probe = await client.probe();
      this.hostErrors.delete(hostId);
      this.probeCache.set(hostId, probe);
      this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      return probe;
    } catch (err) {
      if (!client.isConnected()) {
        client.close();
        this.clients.delete(hostId);
      }
      this.hostErrors.set(hostId, (err as Error).message);
      this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
      throw err;
    }
  }

  async refreshProfileModels(profileId: string): Promise<CatalogSnapshot> {
    const profile = this.store.getProfile(profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    const host = this.store.getHost(profile.hostId);
    if (!host) throw new Error(`Unknown host: ${profile.hostId}`);

    if (host.transport === "tailnet-direct") {
      await this.connectHost(host.id);
      const client = this.clients.get(host.id)!;

      let models = [] as CatalogSnapshot["models"];
      if (profile.agent === "claude") {
        models = getClaudeFallbackModels();
      } else {
        const raw = await client.discoverCatalogRaw(profile.agent, profile.remoteBin);
        if (profile.agent === "antigravity") {
          models = parseAgyModelsOutput(raw.rawOutput);
        } else if (profile.agent === "kiro") {
          models = parseKiroModelsOutput(raw.rawOutput);
        } else if (profile.agent === "factory-droid") {
          models = parseFactoryCustomModelsJson(raw.rawOutput);
        } else if (raw.rawOutput) {
          models = parseGenericModelLines(raw.rawOutput);
        }
      }

      const snapshot: CatalogSnapshot = {
        hostId: host.id,
        profileId: profile.id,
        agent: profile.agent,
        models,
        fetchedAt: new Date().toISOString(),
      };
      this.store.upsertCatalog(snapshot);
      this.broadcast({ type: "catalog_updated", payload: snapshot });
      return snapshot;
    }

    // Local host mode: spawn agy/opencode directly to inspect live ACP session/new catalog
    const sandbox = new WorkspaceSandbox({ workspaceRoot: process.cwd(), readOnly: true });
    const engine = new LocalToolEngine({ sandbox, policy: new PolicyEngine({ mode: "plan" }) });
    const channel = new LocalProcessChannel({
      sessionId: `probe-${crypto.randomUUID()}`,
      command: profile.remoteBin ?? (profile.agent === "opencode" ? "opencode" : "agy"),
      args: profile.agent === "opencode" ? ["acp"] : ["acp", "--stdio"],
    });
    const acp = new AcpRemoteSession({
      channel,
      toolEngine: engine,
      sessionId: channel.sessionId,
      blockRemoteBuiltins: true,
    });
    try {
      await acp.initialize();
      const sessNew = await acp.startSession();
      const snapshot = acp.extractCatalogSnapshot(
        host.id,
        profile.id,
        profile.agent === "opencode" ? "opencode" : "antigravity",
        sessNew,
      );
      this.store.upsertCatalog(snapshot);
      this.broadcast({ type: "catalog_updated", payload: snapshot });
      return snapshot;
    } finally {
      channel.kill();
    }
  }

  async refreshProfileQuota(profileId: string): Promise<QuotaSnapshot> {
    const profile = this.store.getProfile(profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    const host = this.store.getHost(profile.hostId);
    if (!host) throw new Error(`Unknown host: ${profile.hostId}`);

    // Live Codex quota via active app-server session or lightweight ephemeral RPC probe
    if (profile.agent === "codex") {
      for (const rt of this.runtimes.values()) {
        if (rt.profileId === profile.id && rt.driver.readQuota) {
          try {
            const snap = await rt.driver.readQuota();
            if (snap) {
              this.store.upsertQuota(snap);
              this.broadcast({ type: "quota_updated", payload: snap });
              return snap;
            }
          } catch {
            // Fall through to ephemeral probe
          }
        }
      }

      const probeSessionId = `codex-quota-${crypto.randomBytes(3).toString("hex")}`;
      try {
        const spawned = await this.spawnOnHost(host, {
          sessionId: probeSessionId,
          agent: "codex",
          command: profile.remoteBin ?? "codex",
          args: ["app-server", "-c", 'sandbox_mode="read-only"', "-c", "ephemeral=true"],
          env: {},
          ephemeralFiles: {},
          enableMcpBridge: false,
        });
        try {
          const snap = await probeCodexRateLimitsOverChannel({
            hostId: host.id,
            profileId: profile.id,
            sessionId: probeSessionId,
            channel: spawned.channel,
          });
          this.store.upsertQuota(snap);
          this.broadcast({ type: "quota_updated", payload: snap });
          return snap;
        } finally {
          spawned.channel.kill();
          await spawned.localHttpMcp?.close();
        }
      } catch (err) {
        const snap: QuotaSnapshot = {
          hostId: host.id,
          profileId: profile.id,
          agent: "codex",
          available: false,
          source: "unavailable",
          windows: [],
          note: `Codex account/rateLimits/read probe failed: ${(err as Error).message}`,
          fetchedAt: new Date().toISOString(),
        };
        this.store.upsertQuota(snap);
        this.broadcast({ type: "quota_updated", payload: snap });
        return snap;
      }
    }

    if (host.transport !== "tailnet-direct") {
      const snap: QuotaSnapshot = {
        hostId: host.id,
        profileId: profile.id,
        agent: profile.agent,
        available: false,
        source: "unavailable",
        windows: [],
        note: "Remote quota probing requires Tailnet Direct remote-node.",
        fetchedAt: new Date().toISOString(),
      };
      this.store.upsertQuota(snap);
      this.broadcast({ type: "quota_updated", payload: snap });
      return snap;
    }

    await this.connectHost(host.id);
    const client = this.clients.get(host.id)!;
    const raw = await client.fetchQuota(profile.agent, profile.remoteBin);
    const catalog = this.store
      .listCatalogs()
      .find((c) => c.hostId === host.id && c.profileId === profile.id);

    const snap: QuotaSnapshot = {
      hostId: host.id,
      profileId: profile.id,
      agent: profile.agent,
      available: raw.available,
      source: raw.source,
      planTier: raw.planTier ?? catalog?.tierName,
      windows: raw.windows ?? [],
      note: raw.note,
      fetchedAt: new Date().toISOString(),
    };
    this.store.upsertQuota(snap);
    this.broadcast({ type: "quota_updated", payload: snap });
    return snap;
  }

  async createThread(input: {
    title: string;
    workspaceRoot: string;
    hostId: string;
    profileId: string;
    createWorktree?: boolean;
    branchName?: string;
    model?: string;
    effort?: ThinkingEffort;
    mode?: string;
    quotaSaverMode?: boolean;
    ephemeralRemote?: boolean;
    subagentOverrides?: Record<string, SubagentTaskOverride>;
  }): Promise<ThreadRecord> {
    const absWorkspace = path.resolve(input.workspaceRoot);
    let worktreePath = absWorkspace;
    let branch = "main";

    const wtMgr = new WorktreeManager(absWorkspace);
    if (input.createWorktree && (await wtMgr.isGitRepo())) {
      const targetBranch =
        input.branchName?.trim() || `ar/${crypto.randomBytes(3).toString("hex")}`;
      const wt = await wtMgr.createWorktree(targetBranch);
      worktreePath = wt.path;
      branch = wt.branch;
    }

    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: `thr_${crypto.randomBytes(6).toString("hex")}`,
      title: input.title || "Untitled Task",
      workspaceRoot: absWorkspace,
      worktreePath,
      branch,
      hostId: input.hostId,
      profileId: input.profileId,
      model: input.model,
      effort: input.effort,
      mode: input.mode ?? "default",
      quotaSaverMode: Boolean(input.quotaSaverMode),
      remoteSessionId: undefined,
      ephemeralRemote: input.ephemeralRemote ?? this.config.hub.ephemeral_remote ?? false,
      subagentOverrides: input.subagentOverrides ?? {},
      usage: {
        mainInputTokens: 0,
        mainOutputTokens: 0,
        mainCachedInputTokens: 0,
        mainReasoningTokens: 0,
        offloadedInputTokens: 0,
        offloadedOutputTokens: 0,
        exact: false,
      },
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    this.store.upsertThread(thread);
    this.broadcast({ type: "thread_created", payload: thread });
    return thread;
  }

  async sendPrompt(
    threadId: string,
    input: {
      prompt: string;
      hostId?: string;
      profileId?: string;
      mainModel?: string;
      mainEffort?: ThinkingEffort;
      mode?: string;
      quotaSaverMode?: boolean;
      subagents?: Record<string, SubagentTaskOverride>;
    },
  ): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    if (input.hostId) thread.hostId = input.hostId;
    if (input.profileId) thread.profileId = input.profileId;
    if ("mainModel" in input) thread.model = input.mainModel || undefined;
    if ("mainEffort" in input) thread.effort = input.mainEffort || undefined;
    if (input.mode) thread.mode = input.mode;
    if (input.quotaSaverMode !== undefined) thread.quotaSaverMode = input.quotaSaverMode;
    if (input.subagents) thread.subagentOverrides = input.subagents;
    thread.status = "running";
    thread.updatedAt = new Date().toISOString();
    this.store.upsertThread(thread);

    // If a prior turn is somehow still running on this thread, force-stop it cleanly before starting a new turn
    // so two prompts never race on the same ACP process and no stale graceTimer can tear down the new turn.
    if (this.activeTurns.has(threadId)) {
      this.cancelThread(threadId, true);
    }

    const turn: ActiveTurn = {
      turnId: crypto.randomUUID(),
      abortController: new AbortController(),
      cancelled: false,
      children: new Map(),
    };
    this.activeTurns.set(threadId, turn);

    const userEv = this.store.appendEvent(threadId, "user_message", {
      text: input.prompt,
      model: thread.model,
      effort: thread.effort,
      quotaSaverMode: thread.quotaSaverMode,
    });
    this.broadcast({ type: "thread_event", payload: userEv });
    this.broadcast({ type: "thread_updated", payload: thread });

    // Launch turn asynchronously so HTTP returns immediately while UI receives real-time WS events
    void this.runPromptTurn(thread, input.prompt, turn);
  }

  resolveApproval(approvalId: string, outcome: ApprovalOutcome): boolean {
    const item = this.pendingApprovals.get(approvalId);
    if (!item) return false;
    this.pendingApprovals.delete(approvalId);
    item.resolve(outcome);
    this.broadcast({ type: "approval_resolved", payload: { id: approvalId, outcome } });
    return true;
  }

  private rejectPendingApprovalsForThread(threadId: string, reason: string): void {
    for (const [id, item] of this.pendingApprovals.entries()) {
      if (item.threadId === threadId) {
        this.pendingApprovals.delete(id);
        const outcome: ApprovalOutcome = { approved: false, reason };
        item.resolve(outcome);
        this.broadcast({ type: "approval_resolved", payload: { id, outcome } });
      }
    }
  }

  private teardownRuntime(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    this.runtimes.delete(threadId);
    try {
      rt.abortController.abort();
    } catch {
      // ignore
    }
    try {
      rt.channel.kill();
    } catch {
      // ignore
    }
    for (const c of rt.localMcpClients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    void rt.localHttpMcp?.close().catch(() => {});
  }

  cancelThread(threadId: string, immediateForce = false): void {
    const turn = this.activeTurns.get(threadId);
    const rt = this.runtimes.get(threadId);

    this.rejectPendingApprovalsForThread(threadId, "Cancelled by user");

    if (!turn) {
      try {
        rt?.driver.cancel();
      } catch {
        // ignore
      }
      const existing = this.store.getThread(threadId);
      if (existing && (existing.status === "running" || existing.status === "waiting_approval")) {
        existing.status = "idle";
        existing.updatedAt = new Date().toISOString();
        this.store.upsertThread(existing);
        this.broadcast({ type: "thread_updated", payload: existing });
      }
      return;
    }

    const alreadyCancelling = turn.cancelled;
    turn.cancelled = true;
    turn.abortController.abort();

    // Immediately stop and kill every active child subagent spawned by this turn
    for (const child of turn.children.values()) {
      try {
        child.cancel();
      } catch {
        // ignore
      }
      try {
        child.forceKill();
      } catch {
        // ignore
      }
    }

    // Ask the main driver to cancel gracefully first
    try {
      rt?.driver.cancel();
    } catch {
      // ignore
    }

    const forceStop = () => {
      if (turn.graceTimer) {
        clearTimeout(turn.graceTimer);
        turn.graceTimer = undefined;
      }
      // Guard against stale grace timers ever tearing down a newer turn's runtime
      if (this.activeTurns.get(threadId) === turn) {
        this.teardownRuntime(threadId);
      }
      turn.forceFinish?.();
    };

    if (alreadyCancelling || immediateForce) {
      // Second click on Cancel (or programmatic preemption) triggers immediate hard stop
      forceStop();
      return;
    }

    if (!turn.graceTimer) {
      // Allow graceful ACP session/cancel enough time (~3.5s) to settle cleanly so the live
      // remote process & conversation stay intact for the next turn; second click forces immediate stop.
      turn.graceTimer = setTimeout(forceStop, 3500);
      turn.graceTimer.unref?.();
    }
  }

  private buildDelegationGuidanceForThread(
    thread: ThreadRecord,
    profile: ProfileRecord,
  ): string | undefined {
    const blueprints = this.store.listBlueprints();
    const catalogsByProfile: Record<string, CatalogSnapshot> = {};
    for (const cat of this.store.listCatalogs()) {
      catalogsByProfile[cat.profileId] = cat;
    }
    const plans = resolveSubagentPlans({
      parentHostId: thread.hostId,
      parentProfileId: profile.id,
      parentAgent: profile.agent,
      parentModel: thread.model ?? profile.defaultModel,
      blueprints,
      overrides: thread.subagentOverrides,
      catalogsByProfile,
    });
    const federated = plans
      .filter((p) => p.enabled && p.track === "federated")
      .map((p) => {
        const targetHost = this.store.getHost(p.hostId);
        return {
          blueprint: p.blueprint,
          targetLabel: `${p.hostId}/${p.profileId}`,
          model: p.model,
          effort: p.effort,
          isLocalHost: targetHost?.transport === "local",
        };
      });
    const text = buildQuotaSaverGuidance(federated, { quotaSaverMode: thread.quotaSaverMode });
    return text || undefined;
  }

  private async runPromptTurn(
    thread: ThreadRecord,
    prompt: string,
    turn: ActiveTurn,
  ): Promise<void> {
    try {
      if (turn.cancelled) throw new TurnCancelledError();
      const rt = await this.ensureRuntime(thread, turn);
      if (turn.cancelled) throw new TurnCancelledError();

      rt.abortController = turn.abortController;
      const effectiveMode = (thread.mode as PermissionMode) || "default";
      rt.policy.setMode(effectiveMode);
      rt.engine.sandbox.setAllowOutsideWorkspace(effectiveMode === "full-access");
      rt.turnReceivedExactUsage = false;
      rt.turnEstimatedOutputTokens = 0;

      const prefixParts: string[] = [];
      if (rt.pendingHistoryPrefix) {
        prefixParts.push(rt.pendingHistoryPrefix);
        rt.pendingHistoryPrefix = undefined;
      }
      const latestProfile = this.store.getProfile(thread.profileId);
      if (latestProfile) {
        const liveGuidance = this.buildDelegationGuidanceForThread(thread, latestProfile);
        if (liveGuidance && liveGuidance !== rt.lastDelegationGuidance) {
          prefixParts.push(liveGuidance);
          rt.lastDelegationGuidance = liveGuidance;
        }
      }
      const effectivePrompt =
        prefixParts.length > 0 ? `${prefixParts.join("\n\n")}\n\n${prompt}` : prompt;

      const resolvedTurn = this.resolveModelAndEffortForProfile(
        thread.hostId,
        thread.profileId,
        thread.model,
        thread.effort,
      );

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finishOk = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const finishErr = (err: unknown) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        turn.forceFinish = () => finishErr(new TurnCancelledError());
        if (turn.cancelled) {
          finishErr(new TurnCancelledError());
          return;
        }
        void rt.driver
          .prompt(effectivePrompt, {
            model: resolvedTurn.model,
            effort: resolvedTurn.effort,
          })
          .then(finishOk, finishErr);
      });

      if (turn.cancelled) {
        throw new TurnCancelledError();
      }

      if (!thread.ephemeralRemote) {
        const rsid = rt.driver.getRemoteSessionId?.();
        if (rsid && rsid !== thread.remoteSessionId) {
          thread.remoteSessionId = rsid;
        }
      }

      // Fall back to lightweight token estimate only when backend did not emit exact usage_delta
      if (!rt.turnReceivedExactUsage) {
        thread.usage.mainInputTokens += Math.ceil(prompt.length / 4);
        thread.usage.mainOutputTokens += rt.turnEstimatedOutputTokens;
      }
      thread.status = "idle";
      thread.updatedAt = new Date().toISOString();
      this.store.upsertThread(thread);
      const doneEv = this.store.appendEvent(thread.id, "turn_completed", { stopReason: "end_turn" });
      this.broadcast({ type: "thread_event", payload: doneEv });
      this.broadcast({ type: "thread_updated", payload: thread });
    } catch (err) {
      if (turn.cancelled || err instanceof TurnCancelledError) {
        thread.status = "idle";
        thread.updatedAt = new Date().toISOString();
        this.store.upsertThread(thread);
        const cancelEv = this.store.appendEvent(thread.id, "turn_cancelled", {
          reason: "Stopped by user",
        });
        this.broadcast({ type: "thread_event", payload: cancelEv });
        this.broadcast({ type: "thread_updated", payload: thread });
      } else {
        thread.status = "error";
        thread.updatedAt = new Date().toISOString();
        this.store.upsertThread(thread);
        const errEv = this.store.appendEvent(thread.id, "error", {
          message: (err as Error).message,
        });
        this.broadcast({ type: "thread_event", payload: errEv });
        this.broadcast({ type: "thread_updated", payload: thread });
      }
    } finally {
      if (turn.graceTimer) {
        clearTimeout(turn.graceTimer);
        turn.graceTimer = undefined;
      }
      turn.forceFinish = undefined;
      if (this.activeTurns.get(thread.id) === turn) {
        this.activeTurns.delete(thread.id);
      }
      this.broadcast({
        type: "tool_activity",
        payload: { threadId: thread.id, phase: "clear" },
      });
    }
  }

  private async ensureRuntime(thread: ThreadRecord, turn: ActiveTurn): Promise<ActiveRuntime> {
    const existing = this.runtimes.get(thread.id);
    if (existing && existing.profileId === thread.profileId && existing.hostId === thread.hostId) {
      return existing;
    }
    if (existing) {
      this.teardownRuntime(thread.id);
    }

    if (turn.cancelled) throw new TurnCancelledError();

    const host = this.store.getHost(thread.hostId);
    const profile = this.store.getProfile(thread.profileId);
    if (!host || !profile) {
      throw new Error(`Invalid host (${thread.hostId}) or profile (${thread.profileId})`);
    }

    const initialMode =
      (thread.mode as PermissionMode) || this.config.permissions.default_mode || "default";
    const sandbox = new WorkspaceSandbox({
      workspaceRoot: thread.worktreePath,
      allowOutsideWorkspace: initialMode === "full-access",
    });
    const policy = new PolicyEngine({
      mode: initialMode,
      rules: this.buildConfiguredPolicyRules(),
    });

    const getCurrentSignal = () =>
      this.activeTurns.get(thread.id)?.abortController.signal ?? turn.abortController.signal;

    const engine = new LocalToolEngine({
      sandbox,
      policy,
      onToolEvent: (ev) => {
        if (ev.toolName === "dispatch_subagent" || ev.toolName === "call_remote_model") return;
        this.broadcast({
          type: "tool_activity",
          payload: {
            threadId: thread.id,
            phase: ev.phase,
            toolName: ev.toolName,
            summary: ev.summary,
            ok: ev.ok,
          },
        });
      },
      onApprovalNeeded: async (req) => {
        if (getCurrentSignal().aborted) {
          return { approved: false, reason: "Cancelled by user" };
        }
        thread.status = "waiting_approval";
        this.store.upsertThread(thread);
        this.broadcast({ type: "thread_updated", payload: thread });
        this.broadcast({ type: "approval_requested", payload: req });

        return await new Promise<ApprovalOutcome>((resolve) => {
          this.pendingApprovals.set(req.id, {
            threadId: thread.id,
            request: req,
            resolve: (outcome) => {
              const activeTurn = this.activeTurns.get(thread.id);
              thread.status = activeTurn && !activeTurn.cancelled ? "running" : "idle";
              this.store.upsertThread(thread);
              this.broadcast({ type: "thread_updated", payload: thread });
              resolve(outcome);
            },
          });
        });
      },
    });

    // Resolve and register Track 2 Federated Subagent tools dynamically (main-host-first by default)
    const resolveLivePlans = () => {
      const latestThread = this.store.getThread(thread.id) ?? thread;
      const latestBlueprints = this.store.listBlueprints();
      const catalogsByProfile: Record<string, CatalogSnapshot> = {};
      for (const cat of this.store.listCatalogs()) {
        catalogsByProfile[cat.profileId] = cat;
      }
      return resolveSubagentPlans({
        parentHostId: host.id,
        parentProfileId: profile.id,
        parentAgent: profile.agent,
        parentModel: latestThread.model ?? profile.defaultModel,
        blueprints: latestBlueprints,
        overrides: latestThread.subagentOverrides,
        catalogsByProfile,
      });
    };
    const plans = resolveLivePlans();

    registerFederatedSubagentTools({
      engine,
      getPlans: resolveLivePlans,
      usage: thread.usage,
      executor: async (call) =>
        this.executeFederatedSubagent(this.store.getThread(thread.id) ?? thread, call),
    });

    const initialDelegationGuidance = this.buildDelegationGuidanceForThread(thread, profile);

    // Collect prior locally stored conversation history (excluding the just-appended current user_message)
    const storedEvents = this.store.listEvents(thread.id);
    const priorEvents =
      storedEvents.length > 0 && storedEvents[storedEvents.length - 1]?.kind === "user_message"
        ? storedEvents.slice(0, -1)
        : storedEvents;
    const localHistoryContext = formatLocalHistoryContext(priorEvents);

    const supportsSystemPromptAppend =
      profile.agent === "antigravity" ||
      profile.agent === "claude" ||
      profile.agent === "codex" ||
      profile.agent === "kiro";
    const willAttemptNativeResume = Boolean(thread.remoteSessionId && !thread.ephemeralRemote);
    const historyDeliveredInSystemPrompt =
      supportsSystemPromptAppend && !willAttemptNativeResume && Boolean(localHistoryContext);
    const combinedExtraPrompt =
      [
        initialDelegationGuidance,
        historyDeliveredInSystemPrompt ? localHistoryContext : undefined,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;

    // Mount configured local stdio MCP servers ([local_mcp.*]) under Policy Gate
    const localMcpConfigs = Object.entries(this.config.local_mcp).map(([name, m]) => ({
      name,
      command: m.command,
      args: m.args,
      env: m.env,
    }));
    const localMcpClients =
      localMcpConfigs.length > 0
        ? await mountLocalMcpServers(engine, localMcpConfigs).catch(() => [])
        : [];

    const mcpHandler = new McpJsonRpcHandler(engine);
    const sessionId = `${thread.id}-${crypto.randomBytes(3).toString("hex")}`;

    const built = buildSpawnSpecForAgent({
      sessionId,
      hostId: host.id,
      profileId: profile.id,
      agent: profile.agent,
      remoteBin: profile.remoteBin,
      localWorkspaceRoot: thread.worktreePath,
      localGitBranch: thread.branch,
      model: thread.model ?? profile.defaultModel,
      effort: thread.effort ?? profile.defaultEffort,
      resumeRemoteSessionId: willAttemptNativeResume ? thread.remoteSessionId : undefined,
      ephemeralRemote: thread.ephemeralRemote,
      quotaSaverPrompt: combinedExtraPrompt,
      nativePlans: plans,
    });

    const spawned = await this.spawnOnHost(host, built.spawn, mcpHandler, () => ({
      sessionId,
      signal: getCurrentSignal(),
      onTerminalOutput: (chunk) => {
        this.broadcast({
          type: "terminal_chunk",
          payload: { threadId: thread.id, chunk },
        });
      },
    }));
    const channel = spawned.channel;

    if (turn.cancelled) {
      channel.kill();
      for (const c of localMcpClients) c.close();
      await spawned.localHttpMcp?.close();
      throw new TurnCancelledError();
    }

    channel.setMcpHandler((req) =>
      mcpHandler.handleRpc(req, {
        sessionId,
        signal: getCurrentSignal(),
        onTerminalOutput: (chunk) => {
          this.broadcast({
            type: "terminal_chunk",
            payload: { threadId: thread.id, chunk },
          });
        },
      }),
    );

    let driver: UnifiedDriverSession;
    try {
      driver = await attachDriverSession({
        agent: profile.agent,
        hostId: host.id,
        profileId: profile.id,
        sessionId,
        channel,
        toolEngine: engine,
        model: thread.model ?? profile.defaultModel,
        effort: thread.effort ?? profile.defaultEffort,
        resumeRemoteSessionId: willAttemptNativeResume ? thread.remoteSessionId : undefined,
        ephemeralRemote: thread.ephemeralRemote,
        systemPromptAppend: built.systemPromptAppend,
        developerInstructions: built.developerInstructions,
      });
    } catch (err) {
      channel.kill();
      for (const c of localMcpClients) c.close();
      await spawned.localHttpMcp?.close();
      throw err;
    }

    if (turn.cancelled) {
      channel.kill();
      for (const c of localMcpClients) c.close();
      await spawned.localHttpMcp?.close();
      throw new TurnCancelledError();
    }

    if (!thread.ephemeralRemote) {
      const rsid = driver.getRemoteSessionId?.();
      if (rsid && rsid !== thread.remoteSessionId) {
        thread.remoteSessionId = rsid;
        this.store.upsertThread(thread);
        this.broadcast({ type: "thread_updated", payload: thread });
      }
      driver.onRemoteSessionId?.((rsidUpdate) => {
        if (rsidUpdate && rsidUpdate !== thread.remoteSessionId) {
          thread.remoteSessionId = rsidUpdate;
          this.store.upsertThread(thread);
          this.broadcast({ type: "thread_updated", payload: thread });
        }
      });
    }

    driver.onQuota?.((snap) => {
      this.store.upsertQuota(snap);
      this.broadcast({ type: "quota_updated", payload: snap });
    });

    // Whenever a fresh remote session starts with prior local turns and history wasn't already
    // delivered via systemPromptAppend/developerInstructions (e.g. OpenCode/Gemini/Droid, or native
    // resume fallback), prepend the restored local transcript once on the first user turn.
    const pendingHistoryPrefix =
      !driver.resumedRemote && !historyDeliveredInSystemPrompt && localHistoryContext
        ? localHistoryContext
        : undefined;

    // Only mark delegation guidance as already delivered when the agent consumed systemPromptAppend /
    // developerInstructions on a fresh session; otherwise runPromptTurn will prepend it once automatically.
    const guidanceDeliveredInSystemPrompt =
      !driver.resumedRemote && Boolean(initialDelegationGuidance) && supportsSystemPromptAppend;

    const rt: ActiveRuntime = {
      threadId: thread.id,
      profileId: profile.id,
      hostId: host.id,
      channel,
      driver,
      engine,
      policy,
      abortController: turn.abortController,
      localMcpClients,
      localHttpMcp: spawned.localHttpMcp,
      pendingHistoryPrefix,
      lastDelegationGuidance: guidanceDeliveredInSystemPrompt
        ? initialDelegationGuidance
        : undefined,
      turnReceivedExactUsage: false,
      turnEstimatedOutputTokens: 0,
    };

    driver.onEvent((ev) => {
      if (ev.type === "usage_delta") {
        rt.turnReceivedExactUsage = true;
        thread.usage.mainInputTokens += ev.inputTokens ?? 0;
        thread.usage.mainOutputTokens += ev.outputTokens ?? 0;
        thread.usage.mainCachedInputTokens += ev.cachedInputTokens ?? 0;
        thread.usage.mainReasoningTokens += ev.reasoningTokens ?? 0;
        if (ev.costUsd !== undefined) {
          thread.usage.totalCostUsd = Number(
            ((thread.usage.totalCostUsd ?? 0) + ev.costUsd).toFixed(6),
          );
        }
        thread.usage.exact = true;
        this.store.upsertThread(thread);
        this.broadcast({ type: "thread_updated", payload: thread });
        return;
      }
      if (ev.type === "tool_update") {
        this.broadcast({
          type: "tool_activity",
          payload: {
            threadId: thread.id,
            phase: ev.status === "completed" || ev.status === "done" ? "end" : "start",
            toolName: ev.toolName ?? "tool",
            summary: ev.summary ?? ev.toolName ?? "tool",
          },
        });
        return;
      }
      if (ev.type === "text_delta" && ev.text) {
        rt.turnEstimatedOutputTokens += Math.ceil(ev.text.length / 4);
      }
      const stored = this.store.appendEvent(thread.id, ev.type, ev as unknown as Record<string, unknown>);
      this.broadcast({ type: "thread_event", payload: stored });
    });

    const initialCatalog = driver.getInitialCatalog?.();
    if (initialCatalog && initialCatalog.models.length > 0) {
      this.store.upsertCatalog(initialCatalog);
      this.broadcast({ type: "catalog_updated", payload: initialCatalog });
    }

    this.runtimes.set(thread.id, rt);
    // Evict runtime if the underlying remote/local CLI process exits unexpectedly so the next turn
    // cleanly respawns and resumes (or restores local history) instead of writing to a dead channel.
    channel.on("exit", () => {
      if (this.runtimes.get(thread.id) === rt) {
        this.runtimes.delete(thread.id);
      }
    });
    return rt;
  }

  private async executeFederatedSubagent(
    parentThread: ThreadRecord,
    call: FederatedSubagentCall,
  ): Promise<FederatedSubagentResult> {
    const turn = this.activeTurns.get(parentThread.id);
    if (turn?.cancelled) {
      return { ok: false, output: "Subagent cancelled by user." };
    }

    const childId = `sub_${crypto.randomBytes(4).toString("hex")}`;
    const host = this.store.getHost(call.hostId);
    const profile = this.store.getProfile(call.profileId);
    if (!host || !profile) {
      return {
        ok: false,
        output: `Federated target not found: host=${call.hostId} profile=${call.profileId}`,
      };
    }

    const sameAsMain = host.id === parentThread.hostId && profile.id === parentThread.profileId;
    const rawChildModel =
      call.model ?? (sameAsMain ? parentThread.model : undefined) ?? profile.defaultModel;
    const resolvedChild = this.resolveModelAndEffortForProfile(
      host.id,
      profile.id,
      rawChildModel,
      call.effort ?? profile.defaultEffort,
    );

    const spawnEv = this.store.appendEvent(parentThread.id, "subagent_started", {
      childId,
      subagentName: call.subagentName,
      hostId: host.id,
      profileId: profile.id,
      model: resolvedChild.model,
      effort: resolvedChild.effort,
      pureInferenceOnly: call.pureInferenceOnly,
      task: call.task.slice(0, 300),
    });
    this.broadcast({ type: "thread_event", payload: spawnEv });

    const emitStage = (stage: "spawning" | "initializing" | "running") => {
      this.broadcast({
        type: "subagent_status",
        payload: {
          threadId: parentThread.id,
          childId,
          subagentName: call.subagentName,
          stage,
        },
      });
    };
    emitStage("spawning");

    const parentMode = (parentThread.mode as PermissionMode) || "default";
    const childPolicyMode: PermissionMode =
      call.readOnly || parentMode === "plan"
        ? "plan"
        : parentMode === "full-access"
          ? "full-access"
          : parentMode === "workspace-full"
            ? "workspace-full"
            : "accept-edits";

    const childSandbox = new WorkspaceSandbox({
      workspaceRoot: parentThread.worktreePath,
      readOnly: call.readOnly || parentMode === "plan",
      allowOutsideWorkspace: parentMode === "full-access",
    });
    const childEngine = new LocalToolEngine({
      sandbox: childSandbox,
      policy: new PolicyEngine({
        mode: childPolicyMode,
        rules: this.buildConfiguredPolicyRules(),
      }),
      onToolEvent: (ev) => {
        this.broadcast({
          type: "subagent_tool",
          payload: {
            threadId: parentThread.id,
            childId,
            subagentName: call.subagentName,
            phase: ev.phase,
            toolName: ev.toolName,
            summary: ev.summary,
            ok: ev.ok,
          },
        });
      },
    });
    const childMcp = new McpJsonRpcHandler(childEngine);

    const built = buildSpawnSpecForAgent({
      sessionId: childId,
      hostId: host.id,
      profileId: profile.id,
      agent: profile.agent,
      remoteBin: profile.remoteBin,
      localWorkspaceRoot: parentThread.worktreePath,
      localGitBranch: parentThread.branch,
      model: resolvedChild.model,
      effort: resolvedChild.effort,
      // Federated subagents are disposable one-shot workers: always isolate ephemerally so they never
      // pollute the remote or local agent's conversation history list.
      ephemeralRemote: true,
      pureInferenceOnly: call.pureInferenceOnly,
      nativePlans: [],
    });

    const childCtxFactory = () => ({
      sessionId: childId,
      signal: turn?.abortController.signal,
      onTerminalOutput: (chunk: string) => {
        this.broadcast({
          type: "terminal_chunk",
          payload: { threadId: parentThread.id, chunk },
        });
      },
    });

    let spawned: { channel: RemoteSessionChannel; localHttpMcp?: LocalHttpMcpServer } | undefined;
    let driver: UnifiedDriverSession | undefined;
    let collected = "";
    let exactIn = 0;
    let exactOut = 0;
    let gotExact = false;

    try {
      spawned = await this.spawnOnHost(host, built.spawn, childMcp, childCtxFactory);
      const channel = spawned.channel;
      channel.setMcpHandler((req) => childMcp.handleRpc(req, childCtxFactory()));

      turn?.children.set(childId, {
        childId,
        cancel: () => driver?.cancel(),
        forceKill: () => channel.kill(),
      });

      if (turn?.cancelled) {
        throw new TurnCancelledError();
      }

      emitStage("initializing");
      driver = await attachDriverSession({
        agent: profile.agent,
        hostId: host.id,
        profileId: profile.id,
        sessionId: childId,
        channel,
        toolEngine: childEngine,
        model: resolvedChild.model,
        effort: resolvedChild.effort,
        ephemeralRemote: true,
        systemPromptAppend: built.systemPromptAppend,
        developerInstructions: built.developerInstructions,
      });

      if (turn?.cancelled) {
        throw new TurnCancelledError();
      }

      driver.onEvent((ev) => {
        if (ev.type === "text_delta" && ev.text) {
          collected += ev.text;
          this.broadcast({
            type: "subagent_stream",
            payload: {
              threadId: parentThread.id,
              childId,
              subagentName: call.subagentName,
              stream: "text",
              text: ev.text,
            },
          });
        } else if (ev.type === "thought_delta" && ev.text) {
          this.broadcast({
            type: "subagent_stream",
            payload: {
              threadId: parentThread.id,
              childId,
              subagentName: call.subagentName,
              stream: "thought",
              text: ev.text,
            },
          });
        } else if (ev.type === "tool_update") {
          this.broadcast({
            type: "subagent_tool",
            payload: {
              threadId: parentThread.id,
              childId,
              subagentName: call.subagentName,
              phase: ev.status === "completed" || ev.status === "done" ? "end" : "start",
              toolName: ev.toolName ?? "tool",
              summary: ev.summary ?? ev.toolName ?? "tool",
            },
          });
        } else if (ev.type === "usage_delta") {
          gotExact = true;
          exactIn += ev.inputTokens ?? 0;
          exactOut += ev.outputTokens ?? 0;
        }
      });

      emitStage("running");

      const childPromptParts: string[] = [];
      if (call.systemPrompt?.trim()) {
        childPromptParts.push(`[Subagent Role: ${call.subagentName}]\n${call.systemPrompt.trim()}`);
      }
      if (!call.pureInferenceOnly) {
        const accessLabel =
          childPolicyMode === "plan"
            ? parentMode === "full-access"
              ? "read-only (unrestricted local paths)"
              : "read-only (workspace)"
            : childPolicyMode === "full-access"
              ? "full unrestricted local access (read/write/delete/run_command)"
              : childPolicyMode === "workspace-full"
                ? "workspace full access (read/write/delete/run_command)"
                : "read-write (scoped workspace edits)";
        const extraToolsHint =
          childPolicyMode === "plan"
            ? ""
            : childPolicyMode === "workspace-full" || childPolicyMode === "full-access"
              ? ", `edit_file`, `write_file`, `delete_file`, `run_command`"
              : ", `edit_file`, `write_file`";
        childPromptParts.push(
          [
            `[Workspace Context]`,
            `Local workspace root: ${parentThread.worktreePath}`,
            `Git branch: ${parentThread.branch}`,
            `Access mode: ${accessLabel}`,
            `Use the \`agent_remote_local\` MCP tools (\`read_file\`, \`list_dir\`, \`glob\`, \`grep\`${extraToolsHint}) with paths relative to the workspace root (e.g. "." or "src/index.ts").`,
          ].join("\n"),
        );
      }
      childPromptParts.push(`[Delegated Task]\n${call.task}`);
      const effectiveChildPrompt = childPromptParts.join("\n\n");

      const activeDriver = driver;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (!settled) {
            settled = true;
            try {
              activeDriver.cancel();
            } catch {
              // ignore
            }
            try {
              channel.kill();
            } catch {
              // ignore
            }
            reject(new TurnCancelledError());
          }
        };
        const sig = turn?.abortController.signal;
        if (sig?.aborted) {
          onAbort();
          return;
        }
        sig?.addEventListener("abort", onAbort, { once: true });
        void activeDriver
          .prompt(effectiveChildPrompt, {
            model: resolvedChild.model,
            effort: resolvedChild.effort,
          })
          .then(
            () => {
              sig?.removeEventListener("abort", onAbort);
              if (!settled) {
                settled = true;
                resolve();
              }
            },
            (err) => {
              sig?.removeEventListener("abort", onAbort);
              if (!settled) {
                settled = true;
                reject(err);
              }
            },
          );
      });

      const inTok = gotExact ? exactIn : Math.ceil(call.task.length / 4);
      const outTok = gotExact ? exactOut : Math.ceil(collected.length / 4);
      const doneEv = this.store.appendEvent(parentThread.id, "subagent_completed", {
        childId,
        subagentName: call.subagentName,
        hostId: host.id,
        profileId: profile.id,
        model: resolvedChild.model,
        effort: resolvedChild.effort,
        ok: true,
        offloadedTokens: inTok + outTok,
        preview: collected.slice(0, 400),
        text: collected.slice(0, 12_000),
      });
      this.broadcast({ type: "thread_event", payload: doneEv });
      return {
        ok: true,
        output: collected || "(completed with empty response)",
        inputTokens: inTok,
        outputTokens: outTok,
      };
    } catch (err) {
      const wasCancelled = Boolean(turn?.cancelled) || err instanceof TurnCancelledError;
      const errMsg = wasCancelled ? "Cancelled by user" : (err as Error).message;
      const doneEv = this.store.appendEvent(parentThread.id, "subagent_completed", {
        childId,
        subagentName: call.subagentName,
        hostId: host.id,
        profileId: profile.id,
        model: resolvedChild.model,
        effort: resolvedChild.effort,
        ok: false,
        cancelled: wasCancelled,
        error: errMsg,
        offloadedTokens: 0,
        preview: collected.slice(0, 400),
        text: collected.slice(0, 12_000),
      });
      this.broadcast({ type: "thread_event", payload: doneEv });
      return {
        ok: false,
        output: wasCancelled
          ? `Subagent "${call.subagentName}" cancelled by user.`
          : `Subagent "${call.subagentName}" failed: ${errMsg}`,
      };
    } finally {
      turn?.children.delete(childId);
      try {
        spawned?.channel.kill();
      } catch {
        // ignore
      }
      await spawned?.localHttpMcp?.close().catch(() => {});
    }
  }

  private resolveModelAndEffortForProfile(
    hostId: string,
    profileId: string,
    requestedModel?: string,
    requestedEffort?: ThinkingEffort,
  ): { model?: string; effort?: ThinkingEffort } {
    const catalog = this.store
      .listCatalogs()
      .find((c) => c.hostId === hostId && c.profileId === profileId);
    if (!catalog || catalog.models.length === 0) {
      return { model: requestedModel, effort: requestedEffort };
    }
    const targetEntry = requestedModel
      ? catalog.models.find(
          (m) =>
            m.id === requestedModel ||
            Boolean(m.effortVariantMap && Object.values(m.effortVariantMap).includes(requestedModel)),
        )
      : catalog.models.find((m) => m.isDefault);
    if (!targetEntry) {
      return { model: requestedModel, effort: requestedEffort };
    }
    const resolved = resolveEffortForModel(targetEntry, requestedEffort);
    return {
      model: requestedModel ? targetEntry.id : requestedModel,
      effort: resolved.resolved,
    };
  }

  private async spawnOnHost(
    host: HostRecord,
    spec: Parameters<TailnetDirectClient["spawnSession"]>[0],
    mcpHandler?: McpJsonRpcHandler,
    ctxFactory?: () => { sessionId: string; signal?: AbortSignal; onTerminalOutput?: (c: string) => void },
  ): Promise<{ channel: RemoteSessionChannel; localHttpMcp?: LocalHttpMcpServer }> {
    if (host.transport === "local") {
      let localHttpMcp: LocalHttpMcpServer | undefined;
      let mcpUrl: string | undefined;
      let mcpToken: string | undefined;
      if (spec.enableMcpBridge && mcpHandler && ctxFactory) {
        localHttpMcp = new LocalHttpMcpServer(mcpHandler, ctxFactory);
        const started = await localHttpMcp.start();
        mcpUrl = started.url;
        mcpToken = started.token;
      }
      return {
        channel: new LocalProcessChannel({
          sessionId: spec.sessionId,
          agent: spec.agent,
          command: spec.command,
          args: spec.args,
          env: spec.env,
          ephemeralRemote: spec.ephemeralRemote,
          mcpEndpointUrl: mcpUrl,
          mcpBearerToken: mcpToken,
        }),
        localHttpMcp,
      };
    }

    if (host.transport === "tailscale-ssh" || host.transport === "openssh") {
      if (!host.sshTarget) {
        throw new Error(`Host "${host.id}" (${host.transport}) requires sshTarget`);
      }
      let localHttpMcp: LocalHttpMcpServer | undefined;
      let localMcpPort: number | undefined;
      let mcpToken: string | undefined;
      if (spec.enableMcpBridge && mcpHandler && ctxFactory) {
        localHttpMcp = new LocalHttpMcpServer(mcpHandler, ctxFactory);
        const started = await localHttpMcp.start();
        localMcpPort = started.port;
        mcpToken = started.token;
      }
      const sshChannel = new SshSessionChannel({
        sshTarget: host.sshTarget,
        transport: host.transport,
        spawnSpec: spec,
        localMcpPort,
        mcpBearerToken: mcpToken,
      });
      await sshChannel.waitForReady();
      return {
        channel: sshChannel,
        localHttpMcp,
      };
    }

    await this.connectHost(host.id);
    const client = this.clients.get(host.id)!;
    return { channel: await client.spawnSession(spec) };
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.uiSockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(raw);
      }
    }
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    try {
      if (pathname === "/api/state" && req.method === "GET") {
        return sendJson(res, 200, this.getFullState());
      }

      if (pathname === "/api/auth/keygen" && req.method === "POST") {
        const body = (await readJsonBody(req)) as {
          type?: "ed25519" | "token";
          comment?: string;
          importPrivateKey?: string;
        };
        if (body.type === "token") {
          return sendJson(res, 200, { ok: true, token: generateApiKey() });
        }
        try {
          const kp = body.importPrivateKey?.trim()
            ? deriveEd25519PublicKey(body.importPrivateKey, body.comment)
            : generateEd25519Keypair(body.comment);
          return sendJson(res, 200, { ok: true, ...kp });
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }

      if (pathname === "/api/hosts" && req.method === "POST") {
        const body = (await readJsonBody(req)) as HostRecord;
        const id = body.id?.trim();
        if (!id) {
          return sendJson(res, 400, { error: "Host ID is required" });
        }
        const existing = this.store.getHost(id);
        const transport = body.transport ?? "tailnet-direct";
        const authMode = body.authMode ?? "tailscale-serve";
        const endpoint =
          transport === "tailnet-direct"
            ? normalizeTailnetEndpoint(body.endpoint ?? "")
            : (body.endpoint ?? "").trim();
        let bearerToken: string | undefined;
        if (authMode === "dev-token") {
          const incomingToken = body.bearerToken?.trim();
          bearerToken =
            !incomingToken || incomingToken === "***" ? existing?.bearerToken : incomingToken;
        }
        let privateKeyPem: string | undefined;
        let publicKey: string | undefined;
        if (authMode === "pubkey") {
          const incomingPriv = body.privateKeyPem?.trim();
          if (incomingPriv && incomingPriv !== "***") {
            try {
              const derived = deriveEd25519PublicKey(incomingPriv, body.name?.trim() || id);
              privateKeyPem = derived.privateKeyPem;
              publicKey = derived.publicKey;
            } catch (err) {
              return sendJson(res, 400, { error: `Invalid Ed25519 private key: ${(err as Error).message}` });
            }
          } else if (existing?.privateKeyPem) {
            privateKeyPem = existing.privateKeyPem;
            publicKey = existing.publicKey;
          } else {
            return sendJson(res, 400, {
              error: "Ed25519 private key is required for pubkey auth (generate a keypair or paste an existing private key)",
            });
          }
        }
        const normalizedHost: HostRecord = {
          id,
          name: body.name?.trim() || id,
          transport,
          endpoint,
          authMode,
          bearerToken,
          privateKeyPem,
          publicKey,
          sshTarget: body.sshTarget?.trim() || undefined,
          maxSessions: Number(body.maxSessions) > 0 ? Number(body.maxSessions) : 8,
        };
        // Evict stale transport client / cached probe / error when host config changes
        this.clients.get(id)?.close();
        this.clients.delete(id);
        this.probeCache.delete(id);
        this.hostErrors.delete(id);
        this.store.upsertHost(normalizedHost);
        const state = this.getFullState();
        this.broadcast({ type: "state_snapshot", payload: state });
        return sendJson(res, 200, {
          ok: true,
          host: {
            ...normalizedHost,
            bearerToken: normalizedHost.bearerToken ? "***" : undefined,
            privateKeyPem: undefined,
            hasPrivateKey: Boolean(normalizedHost.privateKeyPem),
          },
          state,
        });
      }

      const hostMatch = /^\/api\/hosts\/([^/]+)(\/(connect|probe))?$/.exec(pathname);
      if (hostMatch) {
        const hostId = decodeURIComponent(hostMatch[1]!);
        const action = hostMatch[3];
        if (req.method === "DELETE" && !action) {
          for (const [tid, rt] of this.runtimes.entries()) {
            if (rt.hostId === hostId) {
              rt.abortController.abort();
              rt.channel.kill();
              for (const c of rt.localMcpClients) c.close();
              await rt.localHttpMcp?.close();
              this.runtimes.delete(tid);
            }
          }
          this.clients.get(hostId)?.close();
          this.clients.delete(hostId);
          this.probeCache.delete(hostId);
          this.hostErrors.delete(hostId);
          this.store.deleteHost(hostId);
          const state = this.getFullState();
          this.broadcast({ type: "state_snapshot", payload: state });
          return sendJson(res, 200, { ok: true, state });
        }
        if (req.method === "POST" && (action === "connect" || action === "probe")) {
          const probe = await this.connectHost(hostId);
          return sendJson(res, 200, { ok: true, probe, state: this.getFullState() });
        }
      }

      if (pathname === "/api/profiles" && req.method === "POST") {
        const body = (await readJsonBody(req)) as ProfileRecord;
        const id = body.id?.trim();
        if (!id) {
          return sendJson(res, 400, { error: "Profile ID is required" });
        }
        const normalizedProfile: ProfileRecord = {
          ...body,
          id,
          name: body.name?.trim() || id,
          hostId: body.hostId?.trim(),
          remoteBin: body.remoteBin?.trim() || undefined,
          defaultModel: body.defaultModel?.trim() || undefined,
        };
        this.store.upsertProfile(normalizedProfile);
        const state = this.getFullState();
        this.broadcast({ type: "state_snapshot", payload: state });
        return sendJson(res, 200, { ok: true, profile: normalizedProfile, state });
      }

      const profMatch = /^\/api\/profiles\/([^/]+)(\/(refresh-models|refresh-quota))?$/.exec(pathname);
      if (profMatch) {
        const profileId = decodeURIComponent(profMatch[1]!);
        if (req.method === "DELETE" && !profMatch[2]) {
          this.store.deleteProfile(profileId);
          const state = this.getFullState();
          this.broadcast({ type: "state_snapshot", payload: state });
          return sendJson(res, 200, { ok: true, state });
        }
        if (req.method === "POST" && profMatch[3] === "refresh-models") {
          const snapshot = await this.refreshProfileModels(profileId);
          return sendJson(res, 200, { ok: true, snapshot });
        }
        if (req.method === "POST" && profMatch[3] === "refresh-quota") {
          const snapshot = await this.refreshProfileQuota(profileId);
          return sendJson(res, 200, { ok: true, snapshot });
        }
      }

      if (pathname === "/api/subagents" && req.method === "POST") {
        const bp = (await readJsonBody(req)) as SubagentBlueprint;
        this.store.upsertBlueprint(bp);
        const state = this.getFullState();
        this.broadcast({ type: "state_snapshot", payload: state });
        return sendJson(res, 200, { ok: true, blueprint: bp, state });
      }

      const subDel = /^\/api\/subagents\/([^/]+)$/.exec(pathname);
      if (subDel && req.method === "DELETE") {
        this.store.deleteBlueprint(decodeURIComponent(subDel[1]!));
        const state = this.getFullState();
        this.broadcast({ type: "state_snapshot", payload: state });
        return sendJson(res, 200, { ok: true, state });
      }

      if (pathname === "/api/threads" && req.method === "POST") {
        const body = (await readJsonBody(req)) as Parameters<AgentRemoteHub["createThread"]>[0];
        const thread = await this.createThread(body);
        return sendJson(res, 200, { ok: true, thread });
      }

      const threadMatch = /^\/api\/threads\/([^/]+)(\/(prompt|cancel|diff|commit|events))?$/.exec(
        pathname,
      );
      if (threadMatch) {
        const threadId = decodeURIComponent(threadMatch[1]!);
        const action = threadMatch[3];
        if (req.method === "GET" && (!action || action === "events")) {
          const thread = this.store.getThread(threadId);
          if (!thread) return sendJson(res, 404, { error: "Thread not found" });
          return sendJson(res, 200, { thread, events: this.store.listEvents(threadId) });
        }
        if (req.method === "DELETE" && !action) {
          this.cancelThread(threadId);
          this.teardownRuntime(threadId);
          this.store.deleteThread(threadId);
          const state = this.getFullState();
          this.broadcast({ type: "state_snapshot", payload: state });
          return sendJson(res, 200, { ok: true, state });
        }
        if (req.method === "POST" && action === "prompt") {
          const body = (await readJsonBody(req)) as Parameters<AgentRemoteHub["sendPrompt"]>[1];
          await this.sendPrompt(threadId, body);
          return sendJson(res, 202, { ok: true });
        }
        if (req.method === "POST" && action === "cancel") {
          this.cancelThread(threadId);
          return sendJson(res, 200, { ok: true, state: this.getFullState() });
        }
        if (req.method === "GET" && action === "diff") {
          const thread = this.store.getThread(threadId);
          if (!thread) return sendJson(res, 404, { error: "Thread not found" });
          const wtMgr = new WorktreeManager(thread.worktreePath);
          const isGit = await wtMgr.isGitRepo();
          if (!isGit) return sendJson(res, 200, { files: [], diff: "" });
          const files = await wtMgr.getStatus(thread.worktreePath);
          const diff = await wtMgr.getDiff(thread.worktreePath);
          return sendJson(res, 200, { files, diff });
        }
        if (req.method === "POST" && action === "commit") {
          const thread = this.store.getThread(threadId);
          if (!thread) return sendJson(res, 404, { error: "Thread not found" });
          const body = (await readJsonBody(req)) as { message: string };
          const wtMgr = new WorktreeManager(thread.worktreePath);
          const sha = await wtMgr.commitAll(body.message || "agent-remote changes", thread.worktreePath);
          return sendJson(res, 200, { ok: true, sha });
        }
      }

      const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
      if (approvalMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as ApprovalOutcome;
        const ok = this.resolveApproval(decodeURIComponent(approvalMatch[1]!), body);
        return sendJson(res, ok ? 200 : 404, { ok });
      }

      // Serve built static Web UI when available
      if (this.webDistDir && fs.existsSync(this.webDistDir)) {
        const safeRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        let target = path.join(this.webDistDir, safeRel);
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
          target = path.join(this.webDistDir, "index.html");
        }
        if (fs.existsSync(target)) {
          res.writeHead(200, { "Content-Type": guessMime(target) });
          fs.createReadStream(target).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  }
}

function parseGenericModelLines(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const id = line.split(/\s+/)[0]!;
      return {
        id,
        displayName: id,
        source: "cli-probe" as const,
        capabilities: { supportsThinking: false, supportedEfforts: [] },
      };
    });
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function guessMime(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
