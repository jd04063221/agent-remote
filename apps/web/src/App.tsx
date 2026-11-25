import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalRequest,
  CatalogSnapshot,
  HubStateSnapshot,
  QuotaSnapshot,
  SubagentOverride,
  ThinkingEffort,
  ThreadEvent,
} from "./types";

const ALL_EFFORTS: ThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function App() {
  const [state, setState] = useState<HubStateSnapshot>({
    hosts: [],
    profiles: [],
    catalogs: [],
    blueprints: [],
    threads: [],
    pendingApprovals: [],
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [eventsByThread, setEventsByThread] = useState<Record<string, ThreadEvent[]>>({});
  const [terminalByThread, setTerminalByThread] = useState<Record<string, string>>({});
  const [diffState, setDiffState] = useState<{ files: Array<{ status: string; path: string }>; diff: string }>({
    files: [],
    diff: "",
  });
  const [inspectorTab, setInspectorTab] = useState<"diff" | "terminal" | "quota">("diff");

  // Composer task-level state
  const [promptText, setPromptText] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedEffort, setSelectedEffort] = useState<ThinkingEffort>("high");
  const [selectedMode, setSelectedMode] = useState<string>("default");
  const [quotaSaver, setQuotaSaver] = useState<boolean>(true);
  const [subagentOverrides, setSubagentOverrides] = useState<Record<string, SubagentOverride>>({});
  const [showSubagentDrawer, setShowSubagentDrawer] = useState(false);

  // Modals & Split Compare
  const [modal, setModal] = useState<null | "host" | "profile" | "thread" | "blueprint">(null);
  const [compareThreadId, setCompareThreadId] = useState<string | null>(null);
  const [blueprintDraft, setBlueprintDraft] = useState({
    name: "reviewer",
    description: "Focused code review subagent",
    systemPrompt: "Review changes concisely and flag security or concurrency issues.",
    toolsText: "read_file, grep, glob, list_dir",
    executionMode: "auto" as "auto" | "native" | "federated",
    defaultProfileId: "",
    defaultModel: "",
    defaultEffort: "high" as ThinkingEffort,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");

  // Form drafts
  const [hostDraft, setHostDraft] = useState({
    id: "us-vps",
    name: "US Tailnet Node",
    transport: "tailnet-direct",
    endpoint: "ws://127.0.0.1:19420/v1/ws",
    authMode: "dev-token",
    bearerToken: "",
    maxSessions: 8,
  });
  const [profileDraft, setProfileDraft] = useState({
    id: "us-agy",
    name: "Antigravity @ US",
    hostId: "us-vps",
    agent: "antigravity",
    remoteBin: "agy",
    defaultModel: "",
    defaultEffort: "high" as ThinkingEffort,
  });
  const [threadDraft, setThreadDraft] = useState({
    title: "New Task",
    workspaceRoot: "",
    profileId: "",
    createWorktree: false,
    branchName: "",
    ephemeralRemote: false,
  });

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  // Connect WebSocket to Local Hub
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as { type: string; payload: unknown };
      if (msg.type === "state_snapshot") {
        const snap = msg.payload as HubStateSnapshot;
        setState(snap);
        if (snap.localEnv?.defaultWorkspaceRoot) {
          setThreadDraft((prev) =>
            prev.workspaceRoot ? prev : { ...prev, workspaceRoot: snap.localEnv!.defaultWorkspaceRoot },
          );
        }
      } else if (msg.type === "catalog_updated") {
        const snap = msg.payload as CatalogSnapshot;
        setState((prev) => ({
          ...prev,
          catalogs: [
            ...prev.catalogs.filter(
              (c) => !(c.hostId === snap.hostId && c.profileId === snap.profileId),
            ),
            snap,
          ],
        }));
      } else if (msg.type === "quota_updated") {
        const snap = msg.payload as QuotaSnapshot;
        setState((prev) => ({
          ...prev,
          quotas: [
            ...(prev.quotas ?? []).filter(
              (q) => !(q.hostId === snap.hostId && q.profileId === snap.profileId),
            ),
            snap,
          ],
        }));
      } else if (msg.type === "thread_created" || msg.type === "thread_updated") {
        const thr = msg.payload as HubStateSnapshot["threads"][number];
        setState((prev) => ({
          ...prev,
          threads: [thr, ...prev.threads.filter((t) => t.id !== thr.id)],
        }));
      } else if (msg.type === "thread_event") {
        const te = msg.payload as ThreadEvent;
        setEventsByThread((prev) => ({
          ...prev,
          [te.threadId]: [...(prev[te.threadId] ?? []), te],
        }));
      } else if (msg.type === "terminal_chunk") {
        const p = msg.payload as { threadId: string; chunk: string };
        setTerminalByThread((prev) => ({
          ...prev,
          [p.threadId]: (prev[p.threadId] ?? "") + p.chunk,
        }));
      } else if (msg.type === "approval_requested") {
        const req = msg.payload as ApprovalRequest;
        setState((prev) => ({
          ...prev,
          pendingApprovals: [...prev.pendingApprovals, req],
        }));
      } else if (msg.type === "approval_resolved") {
        const { id } = msg.payload as { id: string };
        setState((prev) => ({
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter((a) => a.id !== id),
        }));
      }
    };
    return () => ws.close();
  }, []);

  // Load events & diff when active or compare thread changes
  useEffect(() => {
    if (!activeThreadId) return;
    void api<{ events: ThreadEvent[] }>(`/api/threads/${activeThreadId}`).then((d) => {
      setEventsByThread((prev) => ({ ...prev, [activeThreadId]: d.events }));
    });
    void refreshDiff(activeThreadId);
  }, [activeThreadId]);

  useEffect(() => {
    if (!compareThreadId) return;
    void api<{ events: ThreadEvent[] }>(`/api/threads/${compareThreadId}`).then((d) => {
      setEventsByThread((prev) => ({ ...prev, [compareThreadId]: d.events }));
    });
  }, [compareThreadId]);

  const activeThread = useMemo(
    () => state.threads.find((t) => t.id === activeThreadId) ?? null,
    [state.threads, activeThreadId],
  );

  // Sync composer controls when switching thread
  useEffect(() => {
    if (!activeThread) return;
    setSelectedProfileId(activeThread.profileId);
    setSelectedModel(activeThread.model ?? "");
    setSelectedEffort(activeThread.effort ?? "high");
    setSelectedMode(activeThread.mode || "default");
    setQuotaSaver(activeThread.quotaSaverMode);
    setSubagentOverrides(activeThread.subagentOverrides ?? {});
  }, [activeThread?.id]);

  const activeProfile = useMemo(
    () => state.profiles.find((p) => p.id === (selectedProfileId || activeThread?.profileId)),
    [state.profiles, selectedProfileId, activeThread],
  );

  const activeCatalog = useMemo(() => {
    if (!activeProfile) return undefined;
    return state.catalogs.find(
      (c) => c.hostId === activeProfile.hostId && c.profileId === activeProfile.id,
    );
  }, [state.catalogs, activeProfile]);

  const selectedModelMeta = useMemo(
    () => activeCatalog?.models.find((m) => m.id === selectedModel),
    [activeCatalog, selectedModel],
  );

  const availableEfforts =
    selectedModelMeta?.capabilities.supportedEfforts.length
      ? selectedModelMeta.capabilities.supportedEfforts
      : ALL_EFFORTS;

  const refreshDiff = async (tid: string) => {
    try {
      const d = await api<{ files: Array<{ status: string; path: string }>; diff: string }>(
        `/api/threads/${tid}/diff`,
      );
      setDiffState(d);
    } catch {
      // ignore non-git dirs
    }
  };

  const handleSendPrompt = async () => {
    if (!activeThread || !promptText.trim()) return;
    const text = promptText;
    setPromptText("");
    try {
      await api(`/api/threads/${activeThread.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          prompt: text,
          hostId: activeProfile?.hostId ?? activeThread.hostId,
          profileId: activeProfile?.id ?? activeThread.profileId,
          mainModel: selectedModel || undefined,
          mainEffort: selectedEffort,
          mode: selectedMode,
          quotaSaverMode: quotaSaver,
          subagents: subagentOverrides,
        }),
      });
    } catch (err) {
      notify(`Send failed: ${(err as Error).message}`);
    }
  };

  const handleApproval = async (id: string, approved: boolean, scope: "once" | "session" = "once") => {
    try {
      await api(`/api/approvals/${id}`, {
        method: "POST",
        body: JSON.stringify(approved ? { approved: true, scope } : { approved: false, reason: "Rejected from UI" }),
      });
      if (activeThreadId) void refreshDiff(activeThreadId);
    } catch (err) {
      notify(`Approval failed: ${(err as Error).message}`);
    }
  };

  const events = activeThreadId ? (eventsByThread[activeThreadId] ?? []) : [];
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  // Collapse consecutive text_delta / thought_delta chunks into readable message bubbles
  const renderedFeed = useMemo(() => {
    const blocks: Array<{ kind: string; text?: string; payload: Record<string, unknown>; id: number }> = [];
    for (const ev of events) {
      const last = blocks[blocks.length - 1];
      if (
        (ev.kind === "text_delta" || ev.kind === "thought_delta") &&
        last &&
        last.kind === ev.kind
      ) {
        last.text = (last.text ?? "") + String(ev.payload.text ?? "");
      } else {
        blocks.push({
          id: ev.id,
          kind: ev.kind,
          text: typeof ev.payload.text === "string" ? ev.payload.text : undefined,
          payload: ev.payload,
        });
      }
    }
    return blocks;
  }, [events]);

  const usage = activeThread?.usage;
  const mainTotal = (usage?.mainInputTokens ?? 0) + (usage?.mainOutputTokens ?? 0);
  const offloadedTotal = (usage?.offloadedInputTokens ?? 0) + (usage?.offloadedOutputTokens ?? 0);
  const offloadPct =
    mainTotal + offloadedTotal > 0
      ? Math.round((offloadedTotal / (mainTotal + offloadedTotal)) * 100)
      : 0;

  return (
    <div className="workbench">
      {/* LEFT SIDEBAR: Threads + Multi-Host Fleet + Subagent Presets */}
      <aside className="sidebar">
        <div className="brand-bar">
          <div className="brand-title">
            <span className={`dot ${wsConnected ? "ok" : "err"}`} />
            <strong>agent-remote</strong>
          </div>
          <button
            className="btn primary sm"
            onClick={() => {
              setThreadDraft((d) => ({
                ...d,
                profileId: d.profileId || state.profiles[0]?.id || "",
              }));
              setModal("thread");
            }}
          >
            + Thread
          </button>
        </div>

        <section className="side-section">
          <div className="section-head">
            <span>THREADS ({state.threads.length})</span>
          </div>
          {state.threads.length === 0 && (
            <div className="empty-hint">Add a Host + Agent Profile, then create a Thread.</div>
          )}
          {state.threads.map((t) => {
            const prof = state.profiles.find((p) => p.id === t.profileId);
            return (
              <div
                key={t.id}
                className={`thread-item ${t.id === activeThreadId ? "active" : ""}`}
                onClick={() => setActiveThreadId(t.id)}
              >
                <div className="thread-row">
                  <span className={`dot ${t.status === "running" ? "warn" : t.status === "waiting_approval" ? "err" : "ok"}`} />
                  <span className="thread-title">{t.title}</span>
                </div>
                <div className="thread-meta">
                  <span>{prof?.agent ?? t.profileId}@{t.hostId}</span>
                  <span className="badge">{t.branch}</span>
                  {t.quotaSaverMode && <span className="badge green">QS</span>}
                  {t.ephemeralRemote && <span className="badge">Incognito</span>}
                </div>
              </div>
            );
          })}
        </section>

        <section className="side-section">
          <div className="section-head">
            <span>REMOTE FLEET ({state.hosts.length})</span>
            <div className="inline-actions">
              <button className="btn ghost xs" onClick={() => setModal("host")}>+ Host</button>
              <button className="btn ghost xs" onClick={() => setModal("profile")}>+ Agent</button>
            </div>
          </div>
          {state.hosts.map((h) => {
            const hostProfiles = state.profiles.filter((p) => p.hostId === h.id);
            return (
              <div key={h.id} className="fleet-card">
                <div className="fleet-head">
                  <span>
                    <span className={`dot ${h.connected ? "ok" : "muted"}`} />
                    <strong>{h.name}</strong>
                  </span>
                  <button
                    className="btn ghost xs"
                    onClick={async () => {
                      try {
                        await api(`/api/hosts/${h.id}/probe`, { method: "POST" });
                        notify(`Connected & probed ${h.name}`);
                      } catch (e) {
                        notify(`Probe failed: ${(e as Error).message}`);
                      }
                    }}
                  >
                    {h.rttMs !== undefined ? `${h.rttMs}ms` : "Connect"}
                  </button>
                </div>
                <div className="fleet-sub">{h.transport} · {h.endpoint}</div>
                {hostProfiles.map((p) => {
                  const cat = state.catalogs.find((c) => c.hostId === h.id && c.profileId === p.id);
                  return (
                    <div key={p.id} className="profile-row">
                      <span>{p.name} ({p.agent})</span>
                      <button
                        className="btn ghost xs"
                        title="Fetch live available models from remote host"
                        onClick={async () => {
                          try {
                            const r = await api<{ snapshot: CatalogSnapshot }>(
                              `/api/profiles/${p.id}/refresh-models`,
                              { method: "POST" },
                            );
                            notify(`Loaded ${r.snapshot.models.length} live models for ${p.name}`);
                          } catch (e) {
                            notify(`Model fetch failed: ${(e as Error).message}`);
                          }
                        }}
                      >
                        {cat ? `${cat.models.length} models ↻` : "Models ↻"}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>

        <section className="side-section">
          <div className="section-head">
            <span>SUBAGENT BLUEPRINTS ({state.blueprints.length})</span>
            <button
              className="btn ghost xs"
              onClick={() => {
                setBlueprintDraft({
                  name: "",
                  description: "",
                  systemPrompt: "",
                  toolsText: "read_file, grep, glob, list_dir",
                  executionMode: "auto",
                  defaultProfileId: "",
                  defaultModel: "",
                  defaultEffort: "medium",
                });
                setModal("blueprint");
              }}
            >
              + Add
            </button>
          </div>
          {state.blueprints.map((bp) => (
            <div
              key={bp.name}
              className="bp-row clickable"
              title="Click to edit subagent blueprint"
              onClick={() => {
                setBlueprintDraft({
                  name: bp.name,
                  description: bp.description,
                  systemPrompt: bp.systemPrompt,
                  toolsText: bp.tools.join(", "),
                  executionMode: bp.executionMode,
                  defaultProfileId: bp.defaultProfileId ?? "",
                  defaultModel: bp.defaultModel ?? "",
                  defaultEffort: bp.defaultEffort ?? "medium",
                });
                setModal("blueprint");
              }}
            >
              <strong>{bp.name}</strong>
              <span className="muted-sm">
                {bp.defaultModel ?? "inherit"} · {bp.defaultEffort ?? "auto"}
              </span>
            </div>
          ))}
        </section>
      </aside>

      {/* CENTER CANVAS: Unified Conversation + Approvals + Per-Task Composer */}
      <main className="canvas">
        {!activeThread ? (
          <div className="welcome">
            <h2>agent-remote Control Workbench</h2>
            <p>
              Manage multiple remote agents across Tailscale Tailnet hosts (or multiple agents on the
              same host) while keeping your codebase, Git worktrees, and shell execution strictly local.
            </p>
            <div className="welcome-steps">
              <button className="btn primary" onClick={() => setModal("host")}>1. Add Remote Host</button>
              <button className="btn" onClick={() => setModal("profile")}>2. Add Agent Profile</button>
              <button className="btn" onClick={() => setModal("thread")}>3. New Thread</button>
            </div>
          </div>
        ) : (
          <>
            <header className="canvas-header">
              <div>
                <strong>{activeThread.title}</strong>
                <span className="header-sub">
                  {activeProfile?.agent ?? activeThread.profileId} @ {activeThread.hostId} · branch{" "}
                  <code>{activeThread.branch}</code>
                </span>
              </div>
              <div className="header-badges">
                {state.threads.length > 1 && (
                  <select
                    value={compareThreadId ?? ""}
                    onChange={(e) => setCompareThreadId(e.target.value || null)}
                    title="Split-pane compare with another thread"
                  >
                    <option value="">Single Pane</option>
                    {state.threads
                      .filter((t) => t.id !== activeThread.id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          Split: {t.title} ({t.profileId}@{t.hostId})
                        </option>
                      ))}
                  </select>
                )}
                {activeThread.ephemeralRemote ? (
                  <span className="badge" title="Remote CLI session persistence disabled; local SQLite restores context">
                    Remote Incognito
                  </span>
                ) : (
                  activeThread.remoteSessionId && (
                    <span className="badge" title={`Resumable remote session: ${activeThread.remoteSessionId}`}>
                      Resumable
                    </span>
                  )
                )}
                {activeCatalog?.tierName && <span className="badge">{activeCatalog.tierName}</span>}
                <span className="badge green">Offloaded: {offloadPct}%</span>
              </div>
            </header>

            <div className={compareThreadId ? "split-feed-grid" : "single-feed-wrap"}>
            <div className="feed">
              {renderedFeed.map((b) => {
                if (b.kind === "user_message") {
                  return (
                    <div key={b.id} className="msg user">
                      <div className="msg-label">
                        You
                        {typeof b.payload.model === "string" && (
                          <span className="badge">{b.payload.model}</span>
                        )}
                        {typeof b.payload.effort === "string" && (
                          <span className="badge">{b.payload.effort}</span>
                        )}
                      </div>
                      <pre className="msg-text">{b.text}</pre>
                    </div>
                  );
                }
                if (b.kind === "thought_delta") {
                  return (
                    <details key={b.id} className="thought-box">
                      <summary>Thinking Process</summary>
                      <pre className="msg-text">{b.text}</pre>
                    </details>
                  );
                }
                if (b.kind === "text_delta") {
                  return (
                    <div key={b.id} className="msg assistant">
                      <div className="msg-label">{activeProfile?.name ?? "Agent"}</div>
                      <pre className="msg-text">{b.text}</pre>
                    </div>
                  );
                }
                if (b.kind === "subagent_started" || b.kind === "subagent_completed") {
                  return (
                    <div key={b.id} className="subagent-card">
                      <div className="subagent-head">
                        <span>
                          Subagent: <strong>{String(b.payload.subagentName)}</strong>
                        </span>
                        <span className="badge">
                          {String(b.payload.profileId ?? "")} · {String(b.payload.model ?? "default")} ·{" "}
                          {String(b.payload.effort ?? "auto")}
                        </span>
                      </div>
                      {b.kind === "subagent_completed" && (
                        <div className="muted-sm">
                          Completed · offloaded ~{String(b.payload.offloadedTokens ?? 0)} tokens
                        </div>
                      )}
                    </div>
                  );
                }
                if (b.kind === "error") {
                  return (
                    <div key={b.id} className="msg error">
                      Error: {String(b.payload.message ?? "Unknown error")}
                    </div>
                  );
                }
                return null;
              })}

              {/* Pending local permission approvals */}
              {state.pendingApprovals.map((req) => (
                <div key={req.id} className="approval-card">
                  <div className="approval-head">
                    <strong>Approval Required: {req.toolName}</strong>
                    <span className="badge">{req.target}</span>
                  </div>
                  <div className="muted-sm">{req.summary}</div>
                  {req.command && <pre className="code-block">$ {req.command}</pre>}
                  {req.diff && <pre className="diff-block">{req.diff}</pre>}
                  <div className="approval-actions">
                    <button className="btn primary sm" onClick={() => void handleApproval(req.id, true, "once")}>
                      Allow Once
                    </button>
                    <button className="btn sm" onClick={() => void handleApproval(req.id, true, "session")}>
                      Allow Session
                    </button>
                    <button className="btn danger sm" onClick={() => void handleApproval(req.id, false)}>
                      Deny
                    </button>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {compareThreadId && (() => {
              const cmpThread = state.threads.find((t) => t.id === compareThreadId);
              const cmpEvents = eventsByThread[compareThreadId] ?? [];
              const cmpBlocks: Array<{ id: number; kind: string; text: string }> = [];
              for (const ev of cmpEvents) {
                const last = cmpBlocks[cmpBlocks.length - 1];
                if ((ev.kind === "text_delta" || ev.kind === "thought_delta") && last && last.kind === ev.kind) {
                  last.text += String(ev.payload.text ?? "");
                } else if (ev.kind === "user_message" || ev.kind === "text_delta" || ev.kind === "thought_delta") {
                  cmpBlocks.push({ id: ev.id, kind: ev.kind, text: String(ev.payload.text ?? "") });
                }
              }
              return (
                <div className="feed compare-pane">
                  <div className="section-head">
                    <span>COMPARE: {cmpThread?.title} ({cmpThread?.profileId}@{cmpThread?.hostId})</span>
                    <button className="btn ghost xs" onClick={() => setCompareThreadId(null)}>×</button>
                  </div>
                  {cmpBlocks.map((cb) => (
                    <div key={cb.id} className={`msg ${cb.kind === "user_message" ? "user" : "assistant"}`}>
                      <div className="msg-label">{cb.kind === "user_message" ? "You" : cmpThread?.profileId}</div>
                      <pre className="msg-text">{cb.text}</pre>
                    </div>
                  ))}
                </div>
              );
            })()}
            </div>

            {/* Per-Task Subagent Override Drawer */}
            {showSubagentDrawer && (
              <div className="subagent-drawer">
                <div className="section-head">
                  <span>PER-TASK SUBAGENT MODEL & EFFORT OVERRIDES</span>
                  <button className="btn ghost xs" onClick={() => setShowSubagentDrawer(false)}>Close</button>
                </div>
                {state.blueprints.map((bp) => {
                  const ov = subagentOverrides[bp.name] ?? {
                    enabled: true,
                    profileId: bp.defaultProfileId ?? "",
                    model: bp.defaultModel ?? "",
                    effort: bp.defaultEffort ?? "medium",
                  };
                  const update = (patch: Partial<SubagentOverride>) =>
                    setSubagentOverrides((prev) => ({
                      ...prev,
                      [bp.name]: { ...ov, ...patch },
                    }));
                  const targetProf = state.profiles.find((p) => p.id === ov.profileId);
                  const targetCat = targetProf
                    ? state.catalogs.find(
                        (c) => c.hostId === targetProf.hostId && c.profileId === targetProf.id,
                      )
                    : undefined;
                  return (
                    <div key={bp.name} className="subagent-override-row">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={ov.enabled}
                          onChange={(e) => update({ enabled: e.target.checked })}
                        />
                        <strong>{bp.name}</strong>
                      </label>
                      <select
                        value={ov.profileId ?? ""}
                        onChange={(e) => {
                          const p = state.profiles.find((x) => x.id === e.target.value);
                          update({ profileId: e.target.value || undefined, hostId: p?.hostId });
                        }}
                      >
                        <option value="">Same as Main</option>
                        {state.profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.agent}@{p.hostId})
                          </option>
                        ))}
                      </select>
                      <input
                        list={`models-${bp.name}`}
                        placeholder="Model ID (e.g. deepseek/deepseek-4.1-flash)"
                        value={ov.model ?? ""}
                        onChange={(e) => update({ model: e.target.value || undefined })}
                      />
                      <datalist id={`models-${bp.name}`}>
                        {(targetCat ?? activeCatalog)?.models.map((m) => (
                          <option key={m.id} value={m.id}>{m.displayName}</option>
                        ))}
                      </datalist>
                      <select
                        value={ov.effort ?? "medium"}
                        onChange={(e) => update({ effort: e.target.value as ThinkingEffort })}
                      >
                        {ALL_EFFORTS.map((ef) => (
                          <option key={ef} value={ef}>{ef}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Composer */}
            <div className="composer">
              <textarea
                rows={3}
                placeholder="Describe your task... (Ctrl/Cmd + Enter to send)"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleSendPrompt();
                  }
                }}
              />
              <div className="composer-controls">
                <select
                  value={selectedProfileId}
                  onChange={(e) => setSelectedProfileId(e.target.value)}
                  title="Target Remote Host & Agent Profile"
                >
                  {state.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.agent}@{p.hostId})
                    </option>
                  ))}
                </select>

                <input
                  list="main-model-list"
                  className="model-input"
                  placeholder={activeCatalog ? `Select model (${activeCatalog.models.length} live)` : "Model ID (auto)"}
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                />
                <datalist id="main-model-list">
                  {activeCatalog?.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </datalist>

                <select
                  value={selectedEffort}
                  onChange={(e) => setSelectedEffort(e.target.value as ThinkingEffort)}
                  title="Main Agent Thinking Effort"
                >
                  {availableEfforts.map((ef) => (
                    <option key={ef} value={ef}>Effort: {ef}</option>
                  ))}
                </select>

                <select value={selectedMode} onChange={(e) => setSelectedMode(e.target.value)}>
                  <option value="default">Ask</option>
                  <option value="accept-edits">Accept Edits</option>
                  <option value="auto">Auto</option>
                  <option value="plan">Plan (Read-Only)</option>
                </select>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={quotaSaver}
                    onChange={(e) => setQuotaSaver(e.target.checked)}
                  />
                  <span>Quota-Saver</span>
                </label>

                <button className="btn ghost sm" onClick={() => setShowSubagentDrawer((v) => !v)}>
                  Subagents ⚙
                </button>

                {activeThread.status === "running" ? (
                  <button
                    className="btn danger sm"
                    onClick={() => void api(`/api/threads/${activeThread.id}/cancel`, { method: "POST" })}
                  >
                    Cancel
                  </button>
                ) : (
                  <button className="btn primary sm" onClick={() => void handleSendPrompt()}>
                    Send
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* RIGHT INSPECTOR: Unified Diff / Local Terminal / Quota Savings */}
      <aside className="inspector">
        <div className="tabs">
          <button className={inspectorTab === "diff" ? "active" : ""} onClick={() => setInspectorTab("diff")}>
            Diff ({diffState.files.length})
          </button>
          <button className={inspectorTab === "terminal" ? "active" : ""} onClick={() => setInspectorTab("terminal")}>
            Terminal
          </button>
          <button className={inspectorTab === "quota" ? "active" : ""} onClick={() => setInspectorTab("quota")}>
            Quota
          </button>
        </div>

        {inspectorTab === "diff" && (
          <div className="inspector-body">
            <div className="section-head">
              <span>CHANGED FILES</span>
              {activeThreadId && (
                <button className="btn ghost xs" onClick={() => void refreshDiff(activeThreadId)}>
                  Refresh ↻
                </button>
              )}
            </div>
            {diffState.files.map((f) => (
              <div key={f.path} className="file-row">
                <span className="badge">{f.status}</span>
                <span>{f.path}</span>
              </div>
            ))}
            <pre className="diff-block">{diffState.diff || "(Working tree clean)"}</pre>
            {activeThreadId && diffState.files.length > 0 && (
              <div className="commit-box">
                <input
                  placeholder="Commit message..."
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                />
                <button
                  className="btn primary sm"
                  onClick={async () => {
                    try {
                      const r = await api<{ sha: string }>(`/api/threads/${activeThreadId}/commit`, {
                        method: "POST",
                        body: JSON.stringify({ message: commitMsg || "feat: agent-remote update" }),
                      });
                      setCommitMsg("");
                      notify(`Committed ${r.sha}`);
                      void refreshDiff(activeThreadId);
                    } catch (e) {
                      notify(`Commit failed: ${(e as Error).message}`);
                    }
                  }}
                >
                  Commit
                </button>
              </div>
            )}
          </div>
        )}

        {inspectorTab === "terminal" && (
          <div className="inspector-body">
            <pre className="code-block">
              {(activeThreadId && terminalByThread[activeThreadId]) || "(No local command output yet)"}
            </pre>
          </div>
        )}

        {inspectorTab === "quota" && (
          <div className="inspector-body">
            <div className="section-head">
              <span>REMOTE AGENT REMAINING QUOTA</span>
              {activeProfile && (
                <button
                  className="btn ghost xs"
                  onClick={async () => {
                    try {
                      await api(`/api/profiles/${activeProfile.id}/refresh-quota`, { method: "POST" });
                      notify(`Checked quota for ${activeProfile.name}`);
                    } catch (e) {
                      notify(`Quota check failed: ${(e as Error).message}`);
                    }
                  }}
                >
                  Check ↻
                </button>
              )}
            </div>
            {(() => {
              const q = activeProfile
                ? (state.quotas ?? []).find(
                    (x) => x.hostId === activeProfile.hostId && x.profileId === activeProfile.id,
                  )
                : undefined;
              if (!q) {
                return <div className="muted-sm">Click "Check ↻" to query remote quota / balance (credentials stay on remote host).</div>;
              }
              return (
                <div className="fleet-card">
                  <div className="fleet-head">
                    <strong>{q.planTier || q.agent}</strong>
                    <span className="badge">{q.source}</span>
                  </div>
                  {q.windows.map((w) => (
                    <div key={w.label} className="profile-row">
                      <div>
                        <span>{w.label}</span>
                        {w.resetsAt && (
                          <div className="muted-sm">Resets {w.resetsAt.replace("T", " ").slice(0, 19)}</div>
                        )}
                      </div>
                      <strong>
                        {w.remainingAmount ??
                          (w.remainingPercent !== undefined ? `${w.remainingPercent.toFixed(0)}% left` : "—")}
                      </strong>
                    </div>
                  ))}
                  {q.note && <div className="muted-sm" style={{ marginTop: 6 }}>{q.note}</div>}
                </div>
              );
            })()}

            <div className="section-head" style={{ marginTop: 8 }}>
              <span>TOKEN USAGE &amp; QUOTA-SAVER</span>
              <span className="badge">{usage?.exact ? "Exact API" : "Estimated"}</span>
            </div>
            <div className="quota-stat">
              <div>Primary Brain Tokens (In / Out)</div>
              <strong>
                {mainTotal.toLocaleString()} ({(usage?.mainInputTokens ?? 0).toLocaleString()} /{" "}
                {(usage?.mainOutputTokens ?? 0).toLocaleString()})
              </strong>
            </div>
            {(usage?.mainCachedInputTokens ?? 0) > 0 && (
              <div className="quota-stat">
                <div>Cached Input Tokens</div>
                <strong>{(usage?.mainCachedInputTokens ?? 0).toLocaleString()}</strong>
              </div>
            )}
            {(usage?.mainReasoningTokens ?? 0) > 0 && (
              <div className="quota-stat">
                <div>Reasoning Tokens</div>
                <strong>{(usage?.mainReasoningTokens ?? 0).toLocaleString()}</strong>
              </div>
            )}
            {usage?.totalCostUsd !== undefined && (
              <div className="quota-stat">
                <div>Reported Session Cost</div>
                <strong>${usage.totalCostUsd.toFixed(4)} USD</strong>
              </div>
            )}
            <div className="quota-stat green">
              <div>Offloaded to Low-Cost Subagents</div>
              <strong>{offloadedTotal.toLocaleString()} ({offloadPct}%)</strong>
            </div>
            <div className="muted-sm">
              Enable <strong>Quota-Saver</strong> and map <code>explorer</code> / <code>implementer</code>{" "}
              to an OpenCode profile (e.g. <code>deepseek/deepseek-4.1-flash</code>) to maximize closed-source quota savings.
            </div>
          </div>
        )}
      </aside>

      {/* MODALS */}
      {modal === "host" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Remote Host</h3>
            <label>Host ID<input value={hostDraft.id} onChange={(e) => setHostDraft({ ...hostDraft, id: e.target.value })} /></label>
            <label>Display Name<input value={hostDraft.name} onChange={(e) => setHostDraft({ ...hostDraft, name: e.target.value })} /></label>
            <label>
              Transport
              <select value={hostDraft.transport} onChange={(e) => setHostDraft({ ...hostDraft, transport: e.target.value })}>
                <option value="tailnet-direct">Tailnet Direct (WSS)</option>
                <option value="local">Local Machine (Direct)</option>
              </select>
            </label>
            <label>Endpoint URL<input value={hostDraft.endpoint} onChange={(e) => setHostDraft({ ...hostDraft, endpoint: e.target.value })} /></label>
            <label>
              Auth Mode
              <select value={hostDraft.authMode} onChange={(e) => setHostDraft({ ...hostDraft, authMode: e.target.value })}>
                <option value="tailscale-serve">Tailscale Serve (WhoIs Header)</option>
                <option value="tailscaled-whois">Tailscaled LocalAPI WhoIs</option>
                <option value="dev-token">Dev Bearer Token</option>
              </select>
            </label>
            {hostDraft.authMode === "dev-token" && (
              <label>Bearer Token<input type="password" value={hostDraft.bearerToken} onChange={(e) => setHostDraft({ ...hostDraft, bearerToken: e.target.value })} /></label>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn primary"
                onClick={async () => {
                  await api("/api/hosts", { method: "POST", body: JSON.stringify(hostDraft) });
                  setModal(null);
                  notify(`Saved host ${hostDraft.name}`);
                }}
              >
                Save Host
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "profile" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Remote Agent Profile</h3>
            <label>Profile ID<input value={profileDraft.id} onChange={(e) => setProfileDraft({ ...profileDraft, id: e.target.value })} /></label>
            <label>Name<input value={profileDraft.name} onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })} /></label>
            <label>
              Host
              <select value={profileDraft.hostId} onChange={(e) => setProfileDraft({ ...profileDraft, hostId: e.target.value })}>
                {state.hosts.map((h) => (
                  <option key={h.id} value={h.id}>{h.name} ({h.id})</option>
                ))}
              </select>
            </label>
            <label>
              Agent CLI
              <select value={profileDraft.agent} onChange={(e) => setProfileDraft({ ...profileDraft, agent: e.target.value })}>
                <option value="antigravity">Antigravity CLI (agy)</option>
                <option value="opencode">OpenCode (opencode)</option>
                <option value="claude">Claude Code (claude)</option>
                <option value="codex">Codex CLI (codex)</option>
                <option value="gemini">Gemini CLI (gemini)</option>
                <option value="kiro">Kiro CLI (kiro-cli)</option>
                <option value="factory-droid">Factory Droid (droid)</option>
              </select>
            </label>
            <label>Remote Binary<input value={profileDraft.remoteBin} onChange={(e) => setProfileDraft({ ...profileDraft, remoteBin: e.target.value })} /></label>
            <label>Default Model (optional)<input value={profileDraft.defaultModel} onChange={(e) => setProfileDraft({ ...profileDraft, defaultModel: e.target.value })} /></label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn primary"
                onClick={async () => {
                  await api("/api/profiles", { method: "POST", body: JSON.stringify(profileDraft) });
                  setModal(null);
                  notify(`Saved profile ${profileDraft.name}`);
                }}
              >
                Save Profile
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "thread" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Agent Thread</h3>
            <label>Title<input value={threadDraft.title} onChange={(e) => setThreadDraft({ ...threadDraft, title: e.target.value })} /></label>
            <label>Local Workspace Path<input value={threadDraft.workspaceRoot} onChange={(e) => setThreadDraft({ ...threadDraft, workspaceRoot: e.target.value })} /></label>
            <label>
              Agent Profile
              <select value={threadDraft.profileId} onChange={(e) => setThreadDraft({ ...threadDraft, profileId: e.target.value })}>
                {state.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.agent}@{p.hostId})</option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={threadDraft.createWorktree}
                onChange={(e) => setThreadDraft({ ...threadDraft, createWorktree: e.target.checked })}
              />
              <span>Isolate in a new Git Worktree branch</span>
            </label>
            {threadDraft.createWorktree && (
              <label>Branch Name (optional)<input value={threadDraft.branchName} onChange={(e) => setThreadDraft({ ...threadDraft, branchName: e.target.value })} /></label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={threadDraft.ephemeralRemote}
                onChange={(e) => setThreadDraft({ ...threadDraft, ephemeralRemote: e.target.checked })}
              />
              <span>Remote incognito (disable remote CLI session persistence; keep history local only)</span>
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn primary"
                onClick={async () => {
                  const prof = state.profiles.find((p) => p.id === threadDraft.profileId);
                  if (!prof) return notify("Please select an Agent Profile first");
                  const r = await api<{ thread: HubStateSnapshot["threads"][number] }>("/api/threads", {
                    method: "POST",
                    body: JSON.stringify({
                      title: threadDraft.title,
                      workspaceRoot: threadDraft.workspaceRoot,
                      hostId: prof.hostId,
                      profileId: prof.id,
                      createWorktree: threadDraft.createWorktree,
                      branchName: threadDraft.branchName || undefined,
                      ephemeralRemote: threadDraft.ephemeralRemote,
                      quotaSaverMode: true,
                    }),
                  });
                  setActiveThreadId(r.thread.id);
                  setModal(null);
                }}
              >
                Create Thread
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "blueprint" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Subagent Blueprint</h3>
            <label>Name<input value={blueprintDraft.name} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, name: e.target.value })} /></label>
            <label>Description<input value={blueprintDraft.description} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, description: e.target.value })} /></label>
            <label>
              Execution Mode
              <select
                value={blueprintDraft.executionMode}
                onChange={(e) =>
                  setBlueprintDraft({
                    ...blueprintDraft,
                    executionMode: e.target.value as "auto" | "native" | "federated",
                  })
                }
              >
                <option value="auto">Auto (Native or Federated)</option>
                <option value="federated">Federated (Cross-Agent / Quota-Saver)</option>
                <option value="native">Native Only</option>
              </select>
            </label>
            <label>
              Default Remote Profile
              <select
                value={blueprintDraft.defaultProfileId}
                onChange={(e) => setBlueprintDraft({ ...blueprintDraft, defaultProfileId: e.target.value })}
              >
                <option value="">Inherit Main Profile</option>
                {state.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.agent}@{p.hostId})</option>
                ))}
              </select>
            </label>
            <label>Default Model (e.g. deepseek/deepseek-4.1-flash)<input value={blueprintDraft.defaultModel} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, defaultModel: e.target.value })} /></label>
            <label>
              Default Thinking Effort
              <select
                value={blueprintDraft.defaultEffort}
                onChange={(e) => setBlueprintDraft({ ...blueprintDraft, defaultEffort: e.target.value as ThinkingEffort })}
              >
                {ALL_EFFORTS.map((ef) => (
                  <option key={ef} value={ef}>{ef}</option>
                ))}
              </select>
            </label>
            <label>Tools (comma-separated)<input value={blueprintDraft.toolsText} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, toolsText: e.target.value })} /></label>
            <label>System Prompt<textarea rows={3} value={blueprintDraft.systemPrompt} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, systemPrompt: e.target.value })} /></label>
            <div className="modal-actions">
              {blueprintDraft.name && state.blueprints.some((b) => b.name === blueprintDraft.name) && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    await api(`/api/subagents/${encodeURIComponent(blueprintDraft.name)}`, { method: "DELETE" });
                    setModal(null);
                    notify(`Deleted subagent ${blueprintDraft.name}`);
                  }}
                >
                  Delete
                </button>
              )}
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn primary"
                onClick={async () => {
                  if (!blueprintDraft.name.trim()) return notify("Subagent name is required");
                  const prof = state.profiles.find((p) => p.id === blueprintDraft.defaultProfileId);
                  await api("/api/subagents", {
                    method: "POST",
                    body: JSON.stringify({
                      name: blueprintDraft.name.trim(),
                      description: blueprintDraft.description.trim() || "Custom subagent",
                      systemPrompt: blueprintDraft.systemPrompt,
                      tools: blueprintDraft.toolsText.split(",").map((s) => s.trim()).filter(Boolean),
                      executionMode: blueprintDraft.executionMode,
                      defaultHostId: prof?.hostId,
                      defaultProfileId: prof?.id,
                      defaultModel: blueprintDraft.defaultModel.trim() || undefined,
                      defaultEffort: blueprintDraft.defaultEffort,
                    }),
                  });
                  setModal(null);
                  notify(`Saved subagent ${blueprintDraft.name}`);
                }}
              >
                Save Blueprint
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
