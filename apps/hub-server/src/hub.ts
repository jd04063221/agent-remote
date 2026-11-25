import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import { buildQuotaSaverGuidance } from "@agent-remote/core";
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
  LocalToolEngine,
  McpJsonRpcHandler,
  PolicyEngine,
  WorkspaceSandbox,
  WorktreeManager,
  type ApprovalOutcome,
  type ApprovalRequest,
  type PermissionMode,
} from "@agent-remote/tool-plane";
import {
  LocalProcessChannel,
  TailnetDirectClient,
  type NodeProbeResult,
  type RemoteSessionChannel,
} from "@agent-remote/transport";

import {
  attachDriverSession,
  buildSpawnSpecForAgent,
  type UnifiedDriverSession,
} from "./driver-factory.js";
import {
  HubStore,
  type HostRecord,
  type ProfileRecord,
  type ThreadRecord,
} from "./store.js";

interface ActiveRuntime {
  threadId: string;
  profileId: string;
  hostId: string;
  channel: RemoteSessionChannel;
  driver: UnifiedDriverSession;
  engine: LocalToolEngine;
  policy: PolicyEngine;
  abortController: AbortController;
}

export interface HubServerOptions {
  port?: number;
  host?: string;
  dbPath: string;
  webDistDir?: string;
}

export class AgentRemoteHub {
  readonly store: HubStore;
  private readonly webDistDir?: string;

  private readonly clients = new Map<string, TailnetDirectClient>();
  private readonly probeCache = new Map<string, NodeProbeResult>();
  private readonly runtimes = new Map<string, ActiveRuntime>();
  private readonly pendingApprovals = new Map<
    string,
    { request: ApprovalRequest; resolve: (o: ApprovalOutcome) => void }
  >();
  private readonly uiSockets = new Set<WebSocket>();

  private httpServer?: http.Server;
  private wss?: WebSocketServer;

  constructor(options: { dbPath: string; webDistDir?: string }) {
    this.store = new HubStore(options.dbPath);
    this.webDistDir = options.webDistDir;
  }

  async listen(port = 3775, host = "127.0.0.1"): Promise<{ url: string; port: number }> {
    this.httpServer = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wss.on("connection", (ws) => {
      this.uiSockets.add(ws);
      ws.send(JSON.stringify({ type: "state_snapshot", payload: this.getFullState() }));
      ws.on("close", () => this.uiSockets.delete(ws));
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => resolve());
    });
    const addr = this.httpServer.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return { url: `http://${host}:${actualPort}`, port: actualPort };
  }

  async close(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      rt.abortController.abort();
      rt.channel.kill();
    }
    this.runtimes.clear();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    for (const ws of this.uiSockets) {
      ws.close();
    }
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.store.close();
  }

  getFullState() {
    const hosts = this.store.listHosts().map((h) => {
      const client = this.clients.get(h.id);
      return {
        ...h,
        bearerToken: h.bearerToken ? "***" : undefined,
        connected: h.transport === "local" ? true : (client?.isConnected() ?? false),
        rttMs: client?.getStatus().rttMs,
        activeSessions: client?.getStatus().activeSessions ?? 0,
        probe: this.probeCache.get(h.id),
      };
    });

    return {
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
    if (host.transport === "local") return null;

    let client = this.clients.get(hostId);
    if (!client) {
      client = new TailnetDirectClient({
        hostId: host.id,
        endpoint: host.endpoint,
        bearerToken: host.bearerToken,
      });
      client.on("connected", () => this.broadcast({ type: "host_updated", payload: { hostId } }));
      client.on("disconnected", () =>
        this.broadcast({ type: "host_updated", payload: { hostId } }),
      );
      this.clients.set(hostId, client);
    }

    if (!client.isConnected()) {
      await client.connect();
    }
    await client.ping();
    const probe = await client.probe();
    this.probeCache.set(hostId, probe);
    this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
    return probe;
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
      subagentOverrides: input.subagentOverrides ?? {},
      usage: {
        mainInputTokens: 0,
        mainOutputTokens: 0,
        offloadedInputTokens: 0,
        offloadedOutputTokens: 0,
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
    if (input.mainModel !== undefined) thread.model = input.mainModel;
    if (input.mainEffort !== undefined) thread.effort = input.mainEffort;
    if (input.mode) thread.mode = input.mode;
    if (input.quotaSaverMode !== undefined) thread.quotaSaverMode = input.quotaSaverMode;
    if (input.subagents) thread.subagentOverrides = input.subagents;
    thread.status = "running";
    thread.updatedAt = new Date().toISOString();
    this.store.upsertThread(thread);

    const userEv = this.store.appendEvent(threadId, "user_message", {
      text: input.prompt,
      model: thread.model,
      effort: thread.effort,
      quotaSaverMode: thread.quotaSaverMode,
    });
    this.broadcast({ type: "thread_event", payload: userEv });
    this.broadcast({ type: "thread_updated", payload: thread });

    // Launch turn asynchronously so HTTP returns immediately while UI receives real-time WS events
    void this.runPromptTurn(thread, input.prompt);
  }

  resolveApproval(approvalId: string, outcome: ApprovalOutcome): boolean {
    const item = this.pendingApprovals.get(approvalId);
    if (!item) return false;
    this.pendingApprovals.delete(approvalId);
    item.resolve(outcome);
    this.broadcast({ type: "approval_resolved", payload: { id: approvalId, outcome } });
    return true;
  }

  cancelThread(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    rt.abortController.abort();
    rt.driver.cancel();
  }

  private async runPromptTurn(thread: ThreadRecord, prompt: string): Promise<void> {
    try {
      const rt = await this.ensureRuntime(thread);
      rt.policy.setMode((thread.mode as PermissionMode) || "default");
      await rt.driver.prompt(prompt, {
        model: thread.model,
        effort: thread.effort,
      });

      // Lightweight token estimate update for primary turn visibility
      thread.usage.mainInputTokens += Math.ceil(prompt.length / 4);
      thread.status = "idle";
      thread.updatedAt = new Date().toISOString();
      this.store.upsertThread(thread);
      const doneEv = this.store.appendEvent(thread.id, "turn_completed", { stopReason: "end_turn" });
      this.broadcast({ type: "thread_event", payload: doneEv });
      this.broadcast({ type: "thread_updated", payload: thread });
    } catch (err) {
      thread.status = "error";
      thread.updatedAt = new Date().toISOString();
      this.store.upsertThread(thread);
      const errEv = this.store.appendEvent(thread.id, "error", {
        message: (err as Error).message,
      });
      this.broadcast({ type: "thread_event", payload: errEv });
      this.broadcast({ type: "thread_updated", payload: thread });
    }
  }

  private async ensureRuntime(thread: ThreadRecord): Promise<ActiveRuntime> {
    const existing = this.runtimes.get(thread.id);
    if (existing && existing.profileId === thread.profileId && existing.hostId === thread.hostId) {
      return existing;
    }
    if (existing) {
      existing.channel.kill();
      this.runtimes.delete(thread.id);
    }

    const host = this.store.getHost(thread.hostId);
    const profile = this.store.getProfile(thread.profileId);
    if (!host || !profile) {
      throw new Error(`Invalid host (${thread.hostId}) or profile (${thread.profileId})`);
    }

    const sandbox = new WorkspaceSandbox({ workspaceRoot: thread.worktreePath });
    const policy = new PolicyEngine({ mode: (thread.mode as PermissionMode) || "default" });
    const abortController = new AbortController();

    const engine = new LocalToolEngine({
      sandbox,
      policy,
      onApprovalNeeded: async (req) => {
        thread.status = "waiting_approval";
        this.store.upsertThread(thread);
        this.broadcast({ type: "thread_updated", payload: thread });
        this.broadcast({ type: "approval_requested", payload: req });

        return await new Promise<ApprovalOutcome>((resolve) => {
          this.pendingApprovals.set(req.id, {
            request: req,
            resolve: (outcome) => {
              thread.status = "running";
              this.store.upsertThread(thread);
              this.broadcast({ type: "thread_updated", payload: thread });
              resolve(outcome);
            },
          });
        });
      },
    });

    // Resolve and register Track 2 Federated Subagent tools (enabling agy -> opencode deepseek offload!)
    const blueprints = this.store.listBlueprints();
    const plans = resolveSubagentPlans({
      parentHostId: host.id,
      parentProfileId: profile.id,
      parentAgent: profile.agent,
      blueprints,
      overrides: thread.subagentOverrides,
    });

    registerFederatedSubagentTools({
      engine,
      plans,
      usage: thread.usage,
      executor: async (call) => this.executeFederatedSubagent(thread, call),
    });

    const quotaPrompt = thread.quotaSaverMode
      ? buildQuotaSaverGuidance(
          plans
            .filter((p) => p.enabled && p.track === "federated")
            .map((p) => ({
              blueprint: p.blueprint,
              targetLabel: `${p.hostId}/${p.profileId}`,
              model: p.model,
              effort: p.effort,
            })),
        )
      : undefined;

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
      quotaSaverPrompt: quotaPrompt,
      nativePlans: plans,
    });

    const channel = await this.spawnOnHost(host, built.spawn);

    channel.setMcpHandler((req) =>
      mcpHandler.handleRpc(req, {
        sessionId,
        signal: abortController.signal,
        onTerminalOutput: (chunk) => {
          this.broadcast({
            type: "terminal_chunk",
            payload: { threadId: thread.id, chunk },
          });
        },
      }),
    );

    const driver = await attachDriverSession({
      agent: profile.agent,
      hostId: host.id,
      profileId: profile.id,
      sessionId,
      channel,
      toolEngine: engine,
      model: thread.model ?? profile.defaultModel,
      effort: thread.effort ?? profile.defaultEffort,
      systemPromptAppend: built.systemPromptAppend,
      developerInstructions: built.developerInstructions,
    });

    driver.onEvent((ev) => {
      if (ev.type === "text_delta" && ev.text) {
        thread.usage.mainOutputTokens += Math.ceil(ev.text.length / 4);
      }
      const stored = this.store.appendEvent(thread.id, ev.type, ev as Record<string, unknown>);
      this.broadcast({ type: "thread_event", payload: stored });
    });

    const initialCatalog = driver.getInitialCatalog?.();
    if (initialCatalog && initialCatalog.models.length > 0) {
      this.store.upsertCatalog(initialCatalog);
      this.broadcast({ type: "catalog_updated", payload: initialCatalog });
    }

    const rt: ActiveRuntime = {
      threadId: thread.id,
      profileId: profile.id,
      hostId: host.id,
      channel,
      driver,
      engine,
      policy,
      abortController,
    };
    this.runtimes.set(thread.id, rt);
    return rt;
  }

  private async executeFederatedSubagent(
    parentThread: ThreadRecord,
    call: FederatedSubagentCall,
  ): Promise<FederatedSubagentResult> {
    const childId = `sub_${crypto.randomBytes(4).toString("hex")}`;
    const spawnEv = this.store.appendEvent(parentThread.id, "subagent_started", {
      childId,
      subagentName: call.subagentName,
      hostId: call.hostId,
      profileId: call.profileId,
      model: call.model,
      effort: call.effort,
      pureInferenceOnly: call.pureInferenceOnly,
    });
    this.broadcast({ type: "thread_event", payload: spawnEv });

    const host = this.store.getHost(call.hostId);
    const profile = this.store.getProfile(call.profileId);
    if (!host || !profile) {
      return {
        ok: false,
        output: `Federated target not found: host=${call.hostId} profile=${call.profileId}`,
      };
    }

    const childSandbox = new WorkspaceSandbox({
      workspaceRoot: parentThread.worktreePath,
      readOnly: call.readOnly,
    });
    const childEngine = new LocalToolEngine({
      sandbox: childSandbox,
      policy: new PolicyEngine({ mode: call.readOnly ? "plan" : "accept-edits" }),
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
      model: call.model ?? profile.defaultModel,
      effort: call.effort ?? profile.defaultEffort,
      pureInferenceOnly: call.pureInferenceOnly,
      nativePlans: [],
    });

    const channel = await this.spawnOnHost(host, built.spawn);
    channel.setMcpHandler((req) => childMcp.handleRpc(req, { sessionId: childId }));

    let collected = "";
    try {
      const driver = await attachDriverSession({
        agent: profile.agent,
        hostId: host.id,
        profileId: profile.id,
        sessionId: childId,
        channel,
        toolEngine: childEngine,
        model: call.model ?? profile.defaultModel,
        effort: call.effort ?? profile.defaultEffort,
        systemPromptAppend: built.systemPromptAppend,
        developerInstructions: built.developerInstructions,
      });

      driver.onEvent((ev) => {
        if (ev.type === "text_delta" && ev.text) {
          collected += ev.text;
        }
      });

      await driver.prompt(call.task, {
        model: call.model ?? profile.defaultModel,
        effort: call.effort ?? profile.defaultEffort,
      });

      const inTok = Math.ceil(call.task.length / 4);
      const outTok = Math.ceil(collected.length / 4);
      const doneEv = this.store.appendEvent(parentThread.id, "subagent_completed", {
        childId,
        subagentName: call.subagentName,
        model: call.model ?? profile.defaultModel,
        effort: call.effort,
        offloadedTokens: inTok + outTok,
        preview: collected.slice(0, 400),
      });
      this.broadcast({ type: "thread_event", payload: doneEv });
      return {
        ok: true,
        output: collected || "(completed with empty response)",
        inputTokens: inTok,
        outputTokens: outTok,
      };
    } catch (err) {
      return {
        ok: false,
        output: `Subagent "${call.subagentName}" failed: ${(err as Error).message}`,
      };
    } finally {
      channel.kill();
    }
  }

  private async spawnOnHost(
    host: HostRecord,
    spec: Parameters<TailnetDirectClient["spawnSession"]>[0],
  ): Promise<RemoteSessionChannel> {
    if (host.transport === "local") {
      return new LocalProcessChannel({
        sessionId: spec.sessionId,
        command: spec.command,
        args: spec.args,
        env: spec.env,
      });
    }
    await this.connectHost(host.id);
    const client = this.clients.get(host.id)!;
    return await client.spawnSession(spec);
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

      if (pathname === "/api/hosts" && req.method === "POST") {
        const body = (await readJsonBody(req)) as HostRecord;
        this.store.upsertHost(body);
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
        return sendJson(res, 200, { ok: true, host: body });
      }

      const hostMatch = /^\/api\/hosts\/([^/]+)(\/(connect|probe))?$/.exec(pathname);
      if (hostMatch) {
        const hostId = decodeURIComponent(hostMatch[1]!);
        const action = hostMatch[3];
        if (req.method === "DELETE" && !action) {
          this.clients.get(hostId)?.close();
          this.clients.delete(hostId);
          this.store.deleteHost(hostId);
          this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === "POST" && (action === "connect" || action === "probe")) {
          const probe = await this.connectHost(hostId);
          return sendJson(res, 200, { ok: true, probe });
        }
      }

      if (pathname === "/api/profiles" && req.method === "POST") {
        const body = (await readJsonBody(req)) as ProfileRecord;
        this.store.upsertProfile(body);
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
        return sendJson(res, 200, { ok: true, profile: body });
      }

      const profMatch = /^\/api\/profiles\/([^/]+)(\/(refresh-models|refresh-quota))?$/.exec(pathname);
      if (profMatch) {
        const profileId = decodeURIComponent(profMatch[1]!);
        if (req.method === "DELETE" && !profMatch[2]) {
          this.store.deleteProfile(profileId);
          this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
          return sendJson(res, 200, { ok: true });
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
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
        return sendJson(res, 200, { ok: true, blueprint: bp });
      }

      const subDel = /^\/api\/subagents\/([^/]+)$/.exec(pathname);
      if (subDel && req.method === "DELETE") {
        this.store.deleteBlueprint(decodeURIComponent(subDel[1]!));
        this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
        return sendJson(res, 200, { ok: true });
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
          this.runtimes.get(threadId)?.channel.kill();
          this.runtimes.delete(threadId);
          this.store.deleteThread(threadId);
          this.broadcast({ type: "state_snapshot", payload: this.getFullState() });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === "POST" && action === "prompt") {
          const body = (await readJsonBody(req)) as Parameters<AgentRemoteHub["sendPrompt"]>[1];
          await this.sendPrompt(threadId, body);
          return sendJson(res, 202, { ok: true });
        }
        if (req.method === "POST" && action === "cancel") {
          this.cancelThread(threadId);
          return sendJson(res, 200, { ok: true });
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
