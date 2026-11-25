import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentKind,
  CatalogSnapshot,
  SubagentBlueprint,
  SubagentTaskOverride,
  ThinkingEffort,
  TokenUsageBreakdown,
  TransportMode,
} from "@agent-remote/protocol";

export interface HostRecord {
  id: string;
  name: string;
  transport: TransportMode | "local";
  endpoint: string;
  authMode: "tailscale-serve" | "tailscaled-whois" | "dev-token" | "none";
  bearerToken?: string;
  sshTarget?: string;
  maxSessions: number;
}

export interface ProfileRecord {
  id: string;
  name: string;
  hostId: string;
  agent: AgentKind;
  remoteBin?: string;
  defaultModel?: string;
  defaultEffort?: ThinkingEffort;
}

export interface ThreadRecord {
  id: string;
  title: string;
  workspaceRoot: string;
  worktreePath: string;
  branch: string;
  hostId: string;
  profileId: string;
  model?: string;
  effort?: ThinkingEffort;
  mode: string;
  quotaSaverMode: boolean;
  subagentOverrides: Record<string, SubagentTaskOverride>;
  usage: TokenUsageBreakdown;
  status: "idle" | "running" | "waiting_approval" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface ThreadEventRecord {
  id: number;
  threadId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const DEFAULT_BLUEPRINTS: SubagentBlueprint[] = [
  {
    name: "explorer",
    description: "Fast codebase scan and concise context summary (quota-saver offload target)",
    systemPrompt:
      "Locate relevant files, symbols, and call chains quickly. Return a crisp structured summary instead of raw file dumps.",
    tools: ["read_file", "grep", "glob", "list_dir"],
    executionMode: "federated",
    defaultModel: "deepseek/deepseek-4.1-flash",
    defaultEffort: "low",
  },
  {
    name: "implementer",
    description: "Scoped code edits and unit test writing delegated from main architect",
    systemPrompt:
      "Implement the requested scoped changes cleanly, run local tests, and report a short summary of modified files and test results.",
    tools: ["read_file", "edit_file", "write_file", "run_command", "grep", "glob"],
    executionMode: "auto",
    defaultModel: "deepseek/deepseek-4.1-flash",
    defaultEffort: "medium",
  },
  {
    name: "architect",
    description: "Deep architectural design, security review, and root-cause analysis",
    systemPrompt:
      "Focus on invariants, concurrency safety, edge cases, and minimal clean designs.",
    tools: ["read_file", "grep", "glob", "list_dir"],
    executionMode: "auto",
    defaultEffort: "xhigh",
  },
];

export class HubStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.migrate();
    this.seedDefaults();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        bearer_token TEXT,
        ssh_target TEXT,
        max_sessions INTEGER NOT NULL DEFAULT 8
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        remote_bin TEXT,
        default_model TEXT,
        default_effort TEXT
      );

      CREATE TABLE IF NOT EXISTS model_catalogs (
        cache_key TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subagent_blueprints (
        name TEXT PRIMARY KEY,
        blueprint_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
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

      CREATE TABLE IF NOT EXISTS thread_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_events_tid ON thread_events(thread_id, id);
    `);
  }

  private seedDefaults(): void {
    const count = this.db
      .prepare("SELECT COUNT(*) as c FROM subagent_blueprints")
      .get() as { c: number };
    if (count.c === 0) {
      for (const bp of DEFAULT_BLUEPRINTS) {
        this.upsertBlueprint(bp);
      }
    }
  }

  // ---- Hosts ----
  listHosts(): HostRecord[] {
    const rows = this.db.prepare("SELECT * FROM hosts ORDER BY name ASC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      transport: String(r.transport) as HostRecord["transport"],
      endpoint: String(r.endpoint),
      authMode: String(r.auth_mode) as HostRecord["authMode"],
      bearerToken: r.bearer_token ? String(r.bearer_token) : undefined,
      sshTarget: r.ssh_target ? String(r.ssh_target) : undefined,
      maxSessions: Number(r.max_sessions),
    }));
  }

  getHost(id: string): HostRecord | undefined {
    return this.listHosts().find((h) => h.id === id);
  }

  upsertHost(host: HostRecord): void {
    this.db
      .prepare(
        `INSERT INTO hosts (id, name, transport, endpoint, auth_mode, bearer_token, ssh_target, max_sessions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, transport=excluded.transport, endpoint=excluded.endpoint,
           auth_mode=excluded.auth_mode, bearer_token=excluded.bearer_token,
           ssh_target=excluded.ssh_target, max_sessions=excluded.max_sessions`,
      )
      .run(
        host.id,
        host.name,
        host.transport,
        host.endpoint,
        host.authMode,
        host.bearerToken ?? null,
        host.sshTarget ?? null,
        host.maxSessions,
      );
  }

  deleteHost(id: string): void {
    this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  }

  // ---- Profiles ----
  listProfiles(): ProfileRecord[] {
    const rows = this.db.prepare("SELECT * FROM profiles ORDER BY name ASC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      hostId: String(r.host_id),
      agent: String(r.agent) as AgentKind,
      remoteBin: r.remote_bin ? String(r.remote_bin) : undefined,
      defaultModel: r.default_model ? String(r.default_model) : undefined,
      defaultEffort: r.default_effort ? (String(r.default_effort) as ThinkingEffort) : undefined,
    }));
  }

  getProfile(id: string): ProfileRecord | undefined {
    return this.listProfiles().find((p) => p.id === id);
  }

  upsertProfile(profile: ProfileRecord): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, host_id, agent, remote_bin, default_model, default_effort)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, host_id=excluded.host_id, agent=excluded.agent,
           remote_bin=excluded.remote_bin, default_model=excluded.default_model,
           default_effort=excluded.default_effort`,
      )
      .run(
        profile.id,
        profile.name,
        profile.hostId,
        profile.agent,
        profile.remoteBin ?? null,
        profile.defaultModel ?? null,
        profile.defaultEffort ?? null,
      );
  }

  deleteProfile(id: string): void {
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }

  // ---- Model Catalog Cache ----
  listCatalogs(): CatalogSnapshot[] {
    const rows = this.db.prepare("SELECT snapshot_json FROM model_catalogs").all() as Array<{
      snapshot_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.snapshot_json) as CatalogSnapshot);
  }

  upsertCatalog(snapshot: CatalogSnapshot): void {
    const key = `${snapshot.hostId}::${snapshot.profileId}`;
    this.db
      .prepare(
        `INSERT INTO model_catalogs (cache_key, host_id, profile_id, snapshot_json, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           snapshot_json=excluded.snapshot_json, fetched_at=excluded.fetched_at`,
      )
      .run(key, snapshot.hostId, snapshot.profileId, JSON.stringify(snapshot), snapshot.fetchedAt);
  }

  // ---- Subagent Blueprints ----
  listBlueprints(): SubagentBlueprint[] {
    const rows = this.db
      .prepare("SELECT blueprint_json FROM subagent_blueprints ORDER BY name ASC")
      .all() as Array<{ blueprint_json: string }>;
    return rows.map((r) => JSON.parse(r.blueprint_json) as SubagentBlueprint);
  }

  upsertBlueprint(bp: SubagentBlueprint): void {
    this.db
      .prepare(
        `INSERT INTO subagent_blueprints (name, blueprint_json) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET blueprint_json=excluded.blueprint_json`,
      )
      .run(bp.name, JSON.stringify(bp));
  }

  deleteBlueprint(name: string): void {
    this.db.prepare("DELETE FROM subagent_blueprints WHERE name = ?").run(name);
  }

  // ---- Threads & Events ----
  listThreads(): ThreadRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToThread);
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToThread(row) : undefined;
  }

  upsertThread(thread: ThreadRecord): void {
    this.db
      .prepare(
        `INSERT INTO threads (
           id, title, workspace_root, worktree_path, branch, host_id, profile_id,
           model, effort, mode, quota_saver_mode, subagent_overrides_json, usage_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, host_id=excluded.host_id, profile_id=excluded.profile_id,
           model=excluded.model, effort=excluded.effort, mode=excluded.mode,
           quota_saver_mode=excluded.quota_saver_mode,
           subagent_overrides_json=excluded.subagent_overrides_json,
           usage_json=excluded.usage_json, status=excluded.status, updated_at=excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.title,
        thread.workspaceRoot,
        thread.worktreePath,
        thread.branch,
        thread.hostId,
        thread.profileId,
        thread.model ?? null,
        thread.effort ?? null,
        thread.mode,
        thread.quotaSaverMode ? 1 : 0,
        JSON.stringify(thread.subagentOverrides),
        JSON.stringify(thread.usage),
        thread.status,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM thread_events WHERE thread_id = ?").run(id);
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  appendEvent(threadId: string, kind: string, payload: Record<string, unknown>): ThreadEventRecord {
    const createdAt = new Date().toISOString();
    const res = this.db
      .prepare(
        "INSERT INTO thread_events (thread_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(threadId, kind, JSON.stringify(payload), createdAt);
    return {
      id: Number(res.lastInsertRowid),
      threadId,
      kind,
      payload,
      createdAt,
    };
  }

  listEvents(threadId: string, limit = 500): ThreadEventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM thread_events WHERE thread_id = ? ORDER BY id ASC LIMIT ?",
      )
      .all(threadId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      threadId: String(r.thread_id),
      kind: String(r.kind),
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
      createdAt: String(r.created_at),
    }));
  }
}

function rowToThread(r: Record<string, unknown>): ThreadRecord {
  const usageParsed = JSON.parse(String(r.usage_json || "{}")) as Partial<TokenUsageBreakdown>;
  return {
    id: String(r.id),
    title: String(r.title),
    workspaceRoot: String(r.workspace_root),
    worktreePath: String(r.worktree_path),
    branch: String(r.branch),
    hostId: String(r.host_id),
    profileId: String(r.profile_id),
    model: r.model ? String(r.model) : undefined,
    effort: r.effort ? (String(r.effort) as ThinkingEffort) : undefined,
    mode: String(r.mode || "default"),
    quotaSaverMode: Number(r.quota_saver_mode) === 1,
    subagentOverrides: JSON.parse(String(r.subagent_overrides_json || "{}")) as Record<
      string,
      SubagentTaskOverride
    >,
    usage: {
      mainInputTokens: usageParsed.mainInputTokens ?? 0,
      mainOutputTokens: usageParsed.mainOutputTokens ?? 0,
      offloadedInputTokens: usageParsed.offloadedInputTokens ?? 0,
      offloadedOutputTokens: usageParsed.offloadedOutputTokens ?? 0,
    },
    status: String(r.status) as ThreadRecord["status"],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
