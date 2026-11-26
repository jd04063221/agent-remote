import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LOCALE_OPTIONS,
  loadInitialLocale,
  saveLocale,
  translate,
  type Locale,
  type MessageKey,
} from "./i18n";
import {
  buildProfileModelOptions,
  coerceEffortForModel,
  findCatalogForProfile,
  findModelInCatalog,
  resolveEffortCapabilities,
  type ModelPickerOption,
} from "./model-utils";
import { MarkdownContent } from "./MarkdownContent";
import { ModelPicker } from "./ModelPicker";
import type {
  ApprovalRequest,
  CatalogSnapshot,
  HostState,
  HubStateSnapshot,
  ProfileState,
  QuotaSnapshot,
  SubagentOverride,
  ThinkingEffort,
  ThreadEvent,
} from "./types";

const DEFAULT_BIN_BY_AGENT: Record<string, string> = {
  antigravity: "agy",
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  kiro: "kiro-cli",
  "factory-droid": "droid",
};

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
  const [locale, setLocale] = useState<Locale>(() => loadInitialLocale());
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );

  const [state, setState] = useState<HubStateSnapshot>({
    hosts: [],
    profiles: [],
    catalogs: [],
    blueprints: [],
    threads: [],
    pendingApprovals: [],
  });

  const appVersion = useMemo(() => {
    const raw =
      state.localEnv?.version ||
      (window as unknown as { agentRemoteDesktop?: { version?: string } }).agentRemoteDesktop
        ?.version ||
      "";
    return raw.trim().replace(/^v/i, "");
  }, [state.localEnv?.version]);

  useEffect(() => {
    saveLocale(locale);
    document.documentElement.lang = locale;
    const baseTitle = translate(locale, "app.title");
    document.title = appVersion
      ? baseTitle.replace("agent-remote", `agent-remote v${appVersion}`)
      : baseTitle;
  }, [locale, appVersion]);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [eventsByThread, setEventsByThread] = useState<Record<string, ThreadEvent[]>>({});
  const [terminalByThread, setTerminalByThread] = useState<Record<string, string>>({});
  const [liveSubagents, setLiveSubagents] = useState<
    Record<
      string,
      {
        stage?: "spawning" | "initializing" | "running";
        thought: string;
        text: string;
        activeTool?: string;
        tools: string[];
      }
    >
  >({});
  const [liveToolByThread, setLiveToolByThread] = useState<
    Record<string, { toolName: string; summary: string } | null>
  >({});
  const [cancellingThreads, setCancellingThreads] = useState<Record<string, boolean>>({});
  const [diffState, setDiffState] = useState<{ files: Array<{ status: string; path: string }>; diff: string }>({
    files: [],
    diff: "",
  });
  const [inspectorTab, setInspectorTab] = useState<"diff" | "terminal" | "quota">("diff");

  // Composer task-level state
  const [promptText, setPromptText] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedEffort, setSelectedEffort] = useState<ThinkingEffort | "">("");
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
    defaultEffort: "" as ThinkingEffort | "",
  });
  const [toast, setToast] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [connectingHosts, setConnectingHosts] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<
    null | { kind: "host" | "profile" | "thread"; id: string }
  >(null);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  // Form drafts
  const [hostDraft, setHostDraft] = useState({
    id: "us-vps",
    name: "US Tailnet Node",
    transport: "tailnet-direct",
    endpoint: "",
    sshTarget: "",
    authMode: "tailscale-serve",
    bearerToken: "",
    hasBearerToken: false,
    maxSessions: 8,
  });
  const [profileDraft, setProfileDraft] = useState({
    id: "us-agy",
    name: "Antigravity @ US",
    hostId: "",
    agent: "antigravity",
    remoteBin: "agy",
    defaultModel: "",
    defaultEffort: "high" as ThinkingEffort,
  });
  const [threadDraft, setThreadDraft] = useState({
    title: "",
    workspaceRoot: "",
    profileId: "",
    createWorktree: false,
    branchName: "",
    ephemeralRemote: false,
  });

  const toastTimerRef = useRef<number | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 5000);
  }, []);

  const applyStateSnapshot = useCallback((snap: HubStateSnapshot) => {
    setState(snap);
    if (snap.localEnv?.defaultWorkspaceRoot) {
      setThreadDraft((prev) =>
        prev.workspaceRoot ? prev : { ...prev, workspaceRoot: snap.localEnv!.defaultWorkspaceRoot },
      );
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const snap = await api<HubStateSnapshot>("/api/state");
      applyStateSnapshot(snap);
    } catch {
      // ignore transient hub restart errors; WS reconnect will sync
    }
  }, [applyStateSnapshot]);

  // Connect WebSocket to Local Hub (with automatic reconnect + initial HTTP snapshot)
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    void refreshState();

    const connectWs = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.onopen = () => {
        setWsConnected(true);
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) {
          reconnectTimer = window.setTimeout(connectWs, 2000);
        }
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as { type: string; payload: unknown };
        if (msg.type === "state_snapshot") {
          applyStateSnapshot(msg.payload as HubStateSnapshot);
        } else if (msg.type === "host_updated") {
          void refreshState();
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
            threads: [thr, ...prev.threads.filter((th) => th.id !== thr.id)],
          }));
          if (thr.status !== "running" && thr.status !== "waiting_approval") {
            setCancellingThreads((prev) => (prev[thr.id] ? { ...prev, [thr.id]: false } : prev));
          }
        } else if (msg.type === "thread_event") {
          const te = msg.payload as ThreadEvent;
          setEventsByThread((prev) => ({
            ...prev,
            [te.threadId]: [...(prev[te.threadId] ?? []), te],
          }));
        } else if (msg.type === "subagent_status") {
          const p = msg.payload as {
            childId: string;
            stage: "spawning" | "initializing" | "running";
          };
          setLiveSubagents((prev) => {
            const cur = prev[p.childId] ?? { thought: "", text: "", tools: [] };
            return { ...prev, [p.childId]: { ...cur, stage: p.stage } };
          });
        } else if (msg.type === "subagent_stream") {
          const p = msg.payload as {
            childId: string;
            stream: "text" | "thought";
            text: string;
          };
          setLiveSubagents((prev) => {
            const cur = prev[p.childId] ?? { stage: "running" as const, thought: "", text: "", tools: [] };
            return {
              ...prev,
              [p.childId]: {
                ...cur,
                stage: "running",
                thought: p.stream === "thought" ? cur.thought + p.text : cur.thought,
                text: p.stream === "text" ? cur.text + p.text : cur.text,
              },
            };
          });
        } else if (msg.type === "subagent_tool") {
          const p = msg.payload as {
            childId: string;
            phase: "start" | "end";
            toolName: string;
            summary: string;
          };
          const label =
            p.summary && p.summary !== p.toolName ? `${p.toolName} ${p.summary}` : p.toolName;
          setLiveSubagents((prev) => {
            const cur = prev[p.childId] ?? { stage: "running" as const, thought: "", text: "", tools: [] };
            const nextTools =
              p.phase === "start" ? [...cur.tools.slice(-11), label] : cur.tools;
            return {
              ...prev,
              [p.childId]: {
                ...cur,
                stage: "running",
                activeTool: p.phase === "start" ? label : undefined,
                tools: nextTools,
              },
            };
          });
        } else if (msg.type === "tool_activity") {
          const p = msg.payload as {
            threadId: string;
            phase: "start" | "end" | "clear";
            toolName?: string;
            summary?: string;
          };
          setLiveToolByThread((prev) => ({
            ...prev,
            [p.threadId]:
              p.phase === "start" && p.toolName
                ? { toolName: p.toolName, summary: p.summary ?? p.toolName }
                : null,
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
    };

    connectWs();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [applyStateSnapshot, refreshState]);

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
    () => state.threads.find((th) => th.id === activeThreadId) ?? null,
    [state.threads, activeThreadId],
  );

  // Sync composer controls when switching thread
  useEffect(() => {
    if (!activeThread) return;
    setSelectedProfileId(activeThread.profileId);
    setSelectedModel(activeThread.model ?? "");
    setSelectedEffort(activeThread.effort ?? "");
    setSelectedMode(activeThread.mode || "default");
    setQuotaSaver(activeThread.quotaSaverMode);
    setSubagentOverrides(activeThread.subagentOverrides ?? {});
  }, [activeThread?.id]);

  const activeProfile = useMemo(
    () => state.profiles.find((p) => p.id === (selectedProfileId || activeThread?.profileId)),
    [state.profiles, selectedProfileId, activeThread],
  );

  const primaryProfile = useMemo(
    () => activeProfile ?? state.profiles[0],
    [activeProfile, state.profiles],
  );

  const activeCatalog = useMemo(
    () => findCatalogForProfile(state.catalogs, activeProfile),
    [state.catalogs, activeProfile],
  );

  const mainModelOptions = useMemo(
    () => buildProfileModelOptions(activeCatalog, activeProfile),
    [activeCatalog, activeProfile],
  );

  const mainEffortCaps = useMemo(
    () => resolveEffortCapabilities(activeCatalog, selectedModel),
    [activeCatalog, selectedModel],
  );
  const availableEfforts = mainEffortCaps.efforts;

  // Keep selectedEffort strictly valid for the active model's live advertised capabilities
  useEffect(() => {
    const coerced = coerceEffortForModel(selectedEffort, activeCatalog, selectedModel, false);
    if (coerced !== selectedEffort) {
      setSelectedEffort(coerced);
    }
  }, [activeCatalog, selectedModel, selectedEffort]);

  // Blueprint modal dynamic model list & capabilities (prioritizes main host agent first)
  const blueprintTargetProfile = useMemo(() => {
    if (blueprintDraft.defaultProfileId) {
      return state.profiles.find((p) => p.id === blueprintDraft.defaultProfileId);
    }
    return primaryProfile;
  }, [blueprintDraft.defaultProfileId, state.profiles, primaryProfile]);

  const blueprintTargetCatalog = useMemo(
    () => findCatalogForProfile(state.catalogs, blueprintTargetProfile),
    [state.catalogs, blueprintTargetProfile],
  );

  const blueprintModelOptions = useMemo<ModelPickerOption[]>(() => {
    if (blueprintDraft.defaultProfileId) {
      return buildProfileModelOptions(blueprintTargetCatalog, blueprintTargetProfile);
    }
    // When inheriting main profile: show primary host's agent models first, then any other connected agents
    const orderedProfiles = primaryProfile
      ? [primaryProfile, ...state.profiles.filter((p) => p.id !== primaryProfile.id)]
      : state.profiles;
    const all: ModelPickerOption[] = [];
    for (const p of orderedProfiles) {
      const cat = findCatalogForProfile(state.catalogs, p);
      all.push(...buildProfileModelOptions(cat, p));
    }
    return all;
  }, [
    blueprintDraft.defaultProfileId,
    blueprintTargetCatalog,
    blueprintTargetProfile,
    primaryProfile,
    state.profiles,
    state.catalogs,
  ]);

  const blueprintEffortCaps = useMemo(() => {
    if (blueprintTargetCatalog) {
      const direct = resolveEffortCapabilities(blueprintTargetCatalog, blueprintDraft.defaultModel);
      if (direct.matchedModel || blueprintDraft.defaultProfileId) {
        return direct;
      }
    }
    // If user typed a model belonging to another connected catalog, inspect that catalog too
    if (blueprintDraft.defaultModel) {
      for (const cat of state.catalogs) {
        const hit = findModelInCatalog(cat, blueprintDraft.defaultModel);
        if (hit) {
          return resolveEffortCapabilities(cat, blueprintDraft.defaultModel);
        }
      }
    }
    return resolveEffortCapabilities(blueprintTargetCatalog, blueprintDraft.defaultModel);
  }, [blueprintTargetCatalog, blueprintDraft.defaultModel, blueprintDraft.defaultProfileId, state.catalogs]);

  const profileModalCatalog = useMemo(() => {
    const target = state.profiles.find(
      (p) => p.id === (editingProfileId ?? profileDraft.id) && p.hostId === profileDraft.hostId,
    );
    return findCatalogForProfile(state.catalogs, target);
  }, [state.profiles, state.catalogs, editingProfileId, profileDraft.id, profileDraft.hostId]);

  const profileModalModelOptions = useMemo(
    () => buildProfileModelOptions(profileModalCatalog),
    [profileModalCatalog],
  );

  const pickerCountLabel = useCallback(
    (shown: number, total: number) => t("picker.count", { shown, total }),
    [t],
  );

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
          mainEffort: selectedEffort || undefined,
          mode: selectedMode,
          quotaSaverMode: quotaSaver,
          subagents: subagentOverrides,
        }),
      });
    } catch (err) {
      notify(t("toast.sendFailed", { msg: (err as Error).message }));
    }
  };

  const handleCancelThread = async (threadId: string) => {
    setCancellingThreads((prev) => ({ ...prev, [threadId]: true }));
    try {
      const r = await api<{ ok: boolean; state?: HubStateSnapshot }>(
        `/api/threads/${encodeURIComponent(threadId)}/cancel`,
        { method: "POST" },
      );
      if (r.state) applyStateSnapshot(r.state);
    } catch (err) {
      setCancellingThreads((prev) => ({ ...prev, [threadId]: false }));
      notify(t("toast.cancelFailed", { msg: (err as Error).message }));
    }
  };

  const handleApproval = async (id: string, approved: boolean, scope: "once" | "session" = "once") => {
    try {
      await api(`/api/approvals/${id}`, {
        method: "POST",
        body: JSON.stringify(
          approved ? { approved: true, scope } : { approved: false, reason: t("approval.rejectedReason") },
        ),
      });
      if (activeThreadId) void refreshDiff(activeThreadId);
    } catch (err) {
      notify(t("toast.approvalFailed", { msg: (err as Error).message }));
    }
  };

  const openNewHostModal = () => {
    setEditingHostId(null);
    setHostDraft({
      id: state.hosts.length === 0 ? "us-vps" : "",
      name: state.hosts.length === 0 ? "Tailnet Remote Node" : "",
      transport: "tailnet-direct",
      endpoint: "",
      sshTarget: "",
      authMode: "tailscale-serve",
      bearerToken: "",
      hasBearerToken: false,
      maxSessions: 8,
    });
    setModal("host");
  };

  const openEditHostModal = (h: HostState) => {
    setEditingHostId(h.id);
    setHostDraft({
      id: h.id,
      name: h.name,
      transport: h.transport,
      endpoint: h.endpoint,
      sshTarget: h.sshTarget ?? "",
      authMode: h.authMode,
      bearerToken: "",
      hasBearerToken: Boolean(h.hasBearerToken),
      maxSessions: h.maxSessions || 8,
    });
    setModal("host");
  };

  const openNewProfileModal = (preferredHostId?: string) => {
    const defaultHostId = preferredHostId || state.hosts[0]?.id || "";
    setEditingProfileId(null);
    setProfileDraft({
      id: state.profiles.length === 0 ? "remote-agy" : "",
      name: state.profiles.length === 0 ? "Antigravity" : "",
      hostId: defaultHostId,
      agent: "antigravity",
      remoteBin: "agy",
      defaultModel: "",
      defaultEffort: "high",
    });
    setModal("profile");
  };

  const openEditProfileModal = (p: ProfileState) => {
    setEditingProfileId(p.id);
    setProfileDraft({
      id: p.id,
      name: p.name,
      hostId: p.hostId,
      agent: p.agent,
      remoteBin: p.remoteBin ?? DEFAULT_BIN_BY_AGENT[p.agent] ?? "",
      defaultModel: p.defaultModel ?? "",
      defaultEffort: p.defaultEffort ?? "high",
    });
    setModal("profile");
  };

  const handleProbeHost = async (hostId: string, hostName: string) => {
    setConnectingHosts((prev) => ({ ...prev, [hostId]: true }));
    try {
      const r = await api<{ ok: boolean; state?: HubStateSnapshot }>(
        `/api/hosts/${encodeURIComponent(hostId)}/probe`,
        { method: "POST" },
      );
      if (r.state) applyStateSnapshot(r.state);
      else await refreshState();
      notify(t("toast.connectedProbed", { name: hostName }));
    } catch (e) {
      await refreshState();
      notify(t("toast.probeFailed", { msg: (e as Error).message }));
    } finally {
      setConnectingHosts((prev) => ({ ...prev, [hostId]: false }));
    }
  };

  const handleDeleteHost = async (h: HostState) => {
    try {
      const r = await api<{ ok: boolean; state?: HubStateSnapshot }>(
        `/api/hosts/${encodeURIComponent(h.id)}`,
        { method: "DELETE" },
      );
      if (r.state) applyStateSnapshot(r.state);
      else await refreshState();
      setConfirmDelete(null);
      if (editingHostId === h.id) setModal(null);
      notify(t("toast.deletedHost", { name: h.name }));
    } catch (e) {
      notify(t("toast.deleteFailed", { msg: (e as Error).message }));
    }
  };

  const handleDeleteProfile = async (p: ProfileState) => {
    try {
      const r = await api<{ ok: boolean; state?: HubStateSnapshot }>(
        `/api/profiles/${encodeURIComponent(p.id)}`,
        { method: "DELETE" },
      );
      if (r.state) applyStateSnapshot(r.state);
      else await refreshState();
      setConfirmDelete(null);
      if (editingProfileId === p.id) setModal(null);
      notify(t("toast.deletedProfile", { name: p.name }));
    } catch (e) {
      notify(t("toast.deleteFailed", { msg: (e as Error).message }));
    }
  };

  const handleDeleteThread = async (threadId: string, title: string) => {
    try {
      const r = await api<{ ok: boolean; state?: HubStateSnapshot }>(
        `/api/threads/${encodeURIComponent(threadId)}`,
        { method: "DELETE" },
      );
      if (r.state) applyStateSnapshot(r.state);
      else await refreshState();
      setConfirmDelete(null);
      if (activeThreadId === threadId) setActiveThreadId(null);
      if (compareThreadId === threadId) setCompareThreadId(null);
      notify(t("toast.deletedThread", { title }));
    } catch (e) {
      notify(t("toast.deleteFailed", { msg: (e as Error).message }));
    }
  };

  const openNewThreadModal = () => {
    setThreadDraft((d) => ({
      ...d,
      title: d.title || t("modal.thread.defaultTitle"),
      profileId:
        state.profiles.some((p) => p.id === d.profileId) ? d.profileId : (state.profiles[0]?.id || ""),
    }));
    setModal("thread");
  };

  const events = activeThreadId ? (eventsByThread[activeThreadId] ?? []) : [];
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  // Collapse consecutive text_delta / thought_delta chunks and merge subagent_started + subagent_completed by childId
  const renderedFeed = useMemo(() => {
    const blocks: Array<{
      kind: string;
      text?: string;
      payload: Record<string, unknown>;
      completedPayload?: Record<string, unknown>;
      id: number;
    }> = [];
    const subagentIndexByChildId = new Map<string, number>();

    for (const ev of events) {
      if (ev.kind === "subagent_started") {
        const childId = typeof ev.payload.childId === "string" ? ev.payload.childId : undefined;
        const idx = blocks.length;
        blocks.push({ id: ev.id, kind: "subagent", payload: ev.payload });
        if (childId) subagentIndexByChildId.set(childId, idx);
        continue;
      }
      if (ev.kind === "subagent_completed") {
        const childId = typeof ev.payload.childId === "string" ? ev.payload.childId : undefined;
        const existingIdx = childId ? subagentIndexByChildId.get(childId) : undefined;
        if (existingIdx !== undefined && blocks[existingIdx]) {
          blocks[existingIdx]!.completedPayload = ev.payload;
        } else {
          blocks.push({
            id: ev.id,
            kind: "subagent",
            payload: ev.payload,
            completedPayload: ev.payload,
          });
        }
        continue;
      }
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
            <div className="brand-text">
              <strong>agent-remote</strong>
              {appVersion && (
                <span className="version-badge" title={`agent-remote v${appVersion}`}>
                  v{appVersion}
                </span>
              )}
            </div>
          </div>
          <div className="brand-actions">
            <select
              className="lang-select"
              aria-label={t("nav.language")}
              title={t("nav.language")}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              {LOCALE_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button className="btn primary sm" onClick={openNewThreadModal}>
              {t("nav.newThread")}
            </button>
          </div>
        </div>

        <section className="side-section">
          <div className="section-head">
            <span>{t("sidebar.threads", { count: state.threads.length })}</span>
          </div>
          {state.threads.length === 0 && (
            <div className="empty-hint">{t("sidebar.threadsEmpty")}</div>
          )}
          {state.threads.map((th) => {
            const prof = state.profiles.find((p) => p.id === th.profileId);
            const isConfirming = confirmDelete?.kind === "thread" && confirmDelete.id === th.id;
            return (
              <div
                key={th.id}
                className={`thread-item ${th.id === activeThreadId ? "active" : ""}`}
                onClick={() => setActiveThreadId(th.id)}
              >
                <div className="thread-row">
                  <span className="thread-title-wrap">
                    <span className={`dot ${th.status === "running" ? "warn" : th.status === "waiting_approval" ? "err" : "ok"}`} />
                    <span className="thread-title">{th.title}</span>
                  </span>
                  {isConfirming ? (
                    <span className="fleet-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn danger xs"
                        onClick={() => void handleDeleteThread(th.id, th.title)}
                      >
                        {t("sidebar.confirmDelete")}
                      </button>
                      <button className="btn ghost xs" onClick={() => setConfirmDelete(null)}>
                        ×
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn danger-ghost xs"
                      title={t("sidebar.deleteThreadTooltip")}
                      aria-label={t("sidebar.deleteThreadTooltip")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete({ kind: "thread", id: th.id });
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="thread-meta">
                  <span>{prof?.agent ?? th.profileId}@{th.hostId}</span>
                  <span className="badge">{th.branch}</span>
                  {th.quotaSaverMode && <span className="badge green">QS</span>}
                  {th.ephemeralRemote && <span className="badge">{t("sidebar.incognito")}</span>}
                </div>
              </div>
            );
          })}
        </section>

        <section className="side-section">
          <div className="section-head">
            <span>{t("sidebar.fleet", { count: state.hosts.length })}</span>
            <div className="inline-actions">
              <button className="btn ghost xs" onClick={openNewHostModal}>
                {t("sidebar.addHost")}
              </button>
              <button className="btn ghost xs" onClick={() => openNewProfileModal()}>
                {t("sidebar.addAgent")}
              </button>
            </div>
          </div>
          {state.hosts.map((h) => {
            const hostProfiles = state.profiles.filter((p) => p.hostId === h.id);
            const isConnecting = Boolean(connectingHosts[h.id]);
            const isConfirmingHost = confirmDelete?.kind === "host" && confirmDelete.id === h.id;
            const installedAgents = h.probe?.agents.filter((a) => a.installed) ?? [];
            return (
              <div key={h.id} className="fleet-card">
                <div className="fleet-head">
                  <span className="fleet-name" title={`${h.name} (${h.id})`}>
                    <span className={`dot ${h.connected ? "ok" : h.lastError ? "err" : "muted"}`} />
                    <strong>{h.name}</strong>
                  </span>
                  <div className="fleet-actions">
                    {h.transport === "local" ? (
                      <span className="badge green">{t("sidebar.localReady")}</span>
                    ) : h.transport === "tailscale-ssh" || h.transport === "openssh" ? (
                      <span className="badge">{t("sidebar.sshReady")}</span>
                    ) : (
                      <button
                        className={`btn xs ${h.connected ? "connected" : "ghost"}`}
                        disabled={isConnecting}
                        onClick={() => void handleProbeHost(h.id, h.name)}
                      >
                        {isConnecting
                          ? t("sidebar.connecting")
                          : h.connected
                            ? h.rttMs !== undefined
                              ? `✓ ${h.rttMs}ms`
                              : `✓ ${t("sidebar.connected")}`
                            : t("sidebar.connect")}
                      </button>
                    )}
                    <button
                      className="btn ghost xs"
                      title={t("sidebar.editHostTooltip")}
                      aria-label={t("sidebar.editHostTooltip")}
                      onClick={() => openEditHostModal(h)}
                    >
                      ✎
                    </button>
                    {isConfirmingHost ? (
                      <>
                        <button
                          className="btn danger xs"
                          onClick={() => void handleDeleteHost(h)}
                        >
                          {t("sidebar.confirmDelete")}
                        </button>
                        <button className="btn ghost xs" onClick={() => setConfirmDelete(null)}>
                          ×
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn danger-ghost xs"
                        title={t("sidebar.deleteHostTooltip")}
                        aria-label={t("sidebar.deleteHostTooltip")}
                        onClick={() => setConfirmDelete({ kind: "host", id: h.id })}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
                <div className="fleet-sub">
                  {h.transport} · {h.transport === "tailnet-direct" ? h.endpoint || h.id : h.sshTarget || h.id}
                </div>
                {h.probe && (
                  <div className="fleet-probe">
                    {h.probe.hostname} ({h.probe.os}/{h.probe.arch}) ·{" "}
                    {t("sidebar.probedAgents", { count: installedAgents.length })}
                  </div>
                )}
                {h.lastError && <div className="fleet-error">{h.lastError}</div>}
                {hostProfiles.map((p) => {
                  const cat = state.catalogs.find((c) => c.hostId === h.id && c.profileId === p.id);
                  const isConfirmingProf =
                    confirmDelete?.kind === "profile" && confirmDelete.id === p.id;
                  return (
                    <div key={p.id} className="profile-row">
                      <span className="profile-name" title={`${p.name} (${p.agent})`}>
                        {p.name} ({p.agent})
                      </span>
                      <div className="profile-actions">
                        <button
                          className="btn ghost xs"
                          title={t("sidebar.modelsTooltip")}
                          onClick={async () => {
                            try {
                              const r = await api<{ snapshot: CatalogSnapshot }>(
                                `/api/profiles/${encodeURIComponent(p.id)}/refresh-models`,
                                { method: "POST" },
                              );
                              notify(
                                t("toast.loadedModels", {
                                  count: r.snapshot.models.length,
                                  name: p.name,
                                }),
                              );
                            } catch (e) {
                              notify(t("toast.modelFetchFailed", { msg: (e as Error).message }));
                            }
                          }}
                        >
                          {cat ? t("sidebar.modelsCount", { count: cat.models.length }) : t("sidebar.models")}
                        </button>
                        <button
                          className="btn ghost xs"
                          title={t("sidebar.editProfileTooltip")}
                          aria-label={t("sidebar.editProfileTooltip")}
                          onClick={() => openEditProfileModal(p)}
                        >
                          ✎
                        </button>
                        {isConfirmingProf ? (
                          <>
                            <button
                              className="btn danger xs"
                              onClick={() => void handleDeleteProfile(p)}
                            >
                              {t("sidebar.confirmDelete")}
                            </button>
                            <button className="btn ghost xs" onClick={() => setConfirmDelete(null)}>
                              ×
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn danger-ghost xs"
                            title={t("sidebar.deleteProfileTooltip")}
                            aria-label={t("sidebar.deleteProfileTooltip")}
                            onClick={() => setConfirmDelete({ kind: "profile", id: p.id })}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>

        <section className="side-section">
          <div className="section-head">
            <span>{t("sidebar.subagents", { count: state.blueprints.length })}</span>
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
                  defaultEffort: "",
                });
                setModal("blueprint");
              }}
            >
              {t("sidebar.add")}
            </button>
          </div>
          {state.blueprints.map((bp) => (
            <div
              key={bp.name}
              className="bp-row clickable"
              title={t("sidebar.editSubagentTooltip")}
              onClick={() => {
                const targetProf = bp.defaultProfileId
                  ? state.profiles.find((p) => p.id === bp.defaultProfileId)
                  : primaryProfile;
                const targetCat = findCatalogForProfile(state.catalogs, targetProf);
                const validEffort = coerceEffortForModel(
                  bp.defaultEffort ?? "",
                  targetCat,
                  bp.defaultModel,
                  true,
                );
                setBlueprintDraft({
                  name: bp.name,
                  description: bp.description,
                  systemPrompt: bp.systemPrompt,
                  toolsText: bp.tools.join(", "),
                  executionMode: bp.executionMode,
                  defaultProfileId: bp.defaultProfileId ?? "",
                  defaultModel: bp.defaultModel ?? "",
                  defaultEffort: validEffort,
                });
                setModal("blueprint");
              }}
            >
              <strong>{bp.name}</strong>
              <span className="muted-sm">
                {bp.defaultModel ?? t("sidebar.inherit")} · {bp.defaultEffort ?? "auto"}
              </span>
            </div>
          ))}
        </section>
      </aside>

      {/* CENTER CANVAS: Unified Conversation + Approvals + Per-Task Composer */}
      <main className="canvas">
        {!activeThread ? (
          <div className="welcome">
            <h2>{t("welcome.title")}</h2>
            <p>{t("welcome.desc")}</p>
            <div className="welcome-steps">
              <button className="btn primary" onClick={openNewHostModal}>
                {t("welcome.step1")}
              </button>
              <button className="btn" onClick={() => openNewProfileModal()}>
                {t("welcome.step2")}
              </button>
              <button className="btn" onClick={openNewThreadModal}>
                {t("welcome.step3")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="canvas-header">
              <div>
                <strong>{activeThread.title}</strong>
                <span className="header-sub">
                  {activeProfile?.agent ?? activeThread.profileId} @ {activeThread.hostId} ·{" "}
                  {t("header.branch")} <code>{activeThread.branch}</code>
                </span>
              </div>
              <div className="header-badges">
                {state.threads.length > 1 && (
                  <select
                    value={compareThreadId ?? ""}
                    onChange={(e) => setCompareThreadId(e.target.value || null)}
                    title={t("header.splitTooltip")}
                  >
                    <option value="">{t("header.singlePane")}</option>
                    {state.threads
                      .filter((th) => th.id !== activeThread.id)
                      .map((th) => (
                        <option key={th.id} value={th.id}>
                          {t("header.splitPrefix", {
                            title: th.title,
                            profile: th.profileId,
                            host: th.hostId,
                          })}
                        </option>
                      ))}
                  </select>
                )}
                {activeThread.ephemeralRemote ? (
                  <span className="badge" title={t("header.incognitoTooltip")}>
                    {t("header.incognitoBadge")}
                  </span>
                ) : (
                  activeThread.remoteSessionId && (
                    <span
                      className="badge"
                      title={t("header.resumableTooltip", { id: activeThread.remoteSessionId })}
                    >
                      {t("header.resumableBadge")}
                    </span>
                  )
                )}
                {activeCatalog?.tierName && <span className="badge">{activeCatalog.tierName}</span>}
                <span className="badge green">{t("header.offloaded", { pct: offloadPct })}</span>
              </div>
            </header>

            <div className={compareThreadId ? "split-feed-grid" : "single-feed-wrap"}>
            <div className="feed">
              {renderedFeed.map((b) => {
                if (b.kind === "user_message") {
                  return (
                    <div key={b.id} className="msg user">
                      <div className="msg-label">
                        {t("feed.you")}
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
                      <summary>{t("feed.thinking")}</summary>
                      <MarkdownContent
                        className="md-muted"
                        content={b.text ?? ""}
                        copyLabel={t("common.copy")}
                        copiedLabel={t("common.copied")}
                      />
                    </details>
                  );
                }
                if (b.kind === "text_delta") {
                  return (
                    <div key={b.id} className="msg assistant">
                      <div className="msg-label">{activeProfile?.name ?? t("feed.agent")}</div>
                      <MarkdownContent
                        content={b.text ?? ""}
                        copyLabel={t("common.copy")}
                        copiedLabel={t("common.copied")}
                      />
                    </div>
                  );
                }
                if (b.kind === "subagent") {
                  const childId = String(b.payload.childId ?? "");
                  const live = childId ? liveSubagents[childId] : undefined;
                  const done = b.completedPayload;
                  const isRunning = !done;
                  const isCancelled = Boolean(done?.cancelled);
                  const isFailed = Boolean(done && done.ok === false);
                  const modelLabel = String(done?.model ?? b.payload.model ?? "default");
                  const effortLabel = String(done?.effort ?? b.payload.effort ?? "auto");
                  const profileLabel = String(done?.profileId ?? b.payload.profileId ?? "");
                  const taskText = typeof b.payload.task === "string" ? b.payload.task : "";
                  const streamText =
                    live?.text ||
                    (typeof done?.text === "string" ? done.text : "") ||
                    (typeof done?.preview === "string" ? done.preview : "");
                  const stageLabel =
                    live?.stage === "spawning"
                      ? t("feed.subagentSpawning")
                      : live?.stage === "initializing"
                        ? t("feed.subagentInitializing")
                        : t("feed.subagentRunning");

                  return (
                    <div
                      key={b.id}
                      className={`subagent-card ${isRunning ? "running" : isFailed ? "failed" : ""}`}
                    >
                      <div className="subagent-head">
                        <span className="subagent-title">
                          <span
                            className={`dot ${
                              isRunning ? "warn pulse" : isFailed ? "err" : "ok"
                            }`}
                          />
                          {t("feed.subagent")} <strong>{String(b.payload.subagentName)}</strong>
                        </span>
                        <span className="badge">
                          {profileLabel} · {modelLabel} · {effortLabel}
                        </span>
                      </div>
                      {taskText && (
                        <div className="subagent-task" title={taskText}>
                          {taskText}
                        </div>
                      )}
                      {isRunning && (
                        <div className="muted-sm">
                          {stageLabel}
                          {live?.activeTool && (
                            <span className="subagent-tool"> · ⚙ {live.activeTool}</span>
                          )}
                        </div>
                      )}
                      {live?.thought && (
                        <details className="subagent-thought" open={isRunning && !streamText}>
                          <summary>{t("feed.thinking")}</summary>
                          <MarkdownContent
                            className="md-muted md-compact"
                            content={live.thought}
                            copyLabel={t("common.copy")}
                            copiedLabel={t("common.copied")}
                          />
                        </details>
                      )}
                      {streamText &&
                        (isRunning ? (
                          <div className="subagent-stream">
                            <MarkdownContent
                              className="md-compact"
                              content={streamText}
                              copyLabel={t("common.copy")}
                              copiedLabel={t("common.copied")}
                            />
                          </div>
                        ) : (
                          <details className="subagent-thought">
                            <summary>{t("feed.subagentOutput")}</summary>
                            <div className="subagent-stream">
                              <MarkdownContent
                                className="md-compact"
                                content={streamText}
                                copyLabel={t("common.copy")}
                                copiedLabel={t("common.copied")}
                              />
                            </div>
                          </details>
                        ))}
                      {done && (
                        <div className={isFailed ? "subagent-err" : "muted-sm"}>
                          {isCancelled
                            ? t("feed.subagentCancelled")
                            : isFailed
                              ? t("feed.subagentFailed", {
                                  msg: String(done.error ?? t("feed.unknownError")),
                                })
                              : t("feed.subagentCompleted", {
                                  tokens: String(done.offloadedTokens ?? 0),
                                })}
                        </div>
                      )}
                    </div>
                  );
                }
                if (b.kind === "turn_cancelled") {
                  return (
                    <div key={b.id} className="turn-cancelled">
                      ⏹ {t("feed.turnCancelled")}
                    </div>
                  );
                }
                if (b.kind === "error") {
                  return (
                    <div key={b.id} className="msg error">
                      {t("feed.error", {
                        msg: String(b.payload.message ?? t("feed.unknownError")),
                      })}
                    </div>
                  );
                }
                return null;
              })}

              {activeThread.status === "running" && (
                <div className="live-activity-bar">
                  <span className="dot warn pulse" />
                  <span>{t("feed.runningStatus")}</span>
                  {liveToolByThread[activeThread.id] && (
                    <span className="live-activity-tool">
                      ⚙ {liveToolByThread[activeThread.id]!.toolName}
                      {liveToolByThread[activeThread.id]!.summary &&
                      liveToolByThread[activeThread.id]!.summary !==
                        liveToolByThread[activeThread.id]!.toolName
                        ? ` ${liveToolByThread[activeThread.id]!.summary}`
                        : ""}
                    </span>
                  )}
                </div>
              )}

              {/* Pending local permission approvals */}
              {state.pendingApprovals.map((req) => (
                <div key={req.id} className="approval-card">
                  <div className="approval-head">
                    <strong>{t("approval.title", { tool: req.toolName })}</strong>
                    <span className="badge">{req.target}</span>
                  </div>
                  <div className="muted-sm">{req.summary}</div>
                  {req.command && <pre className="code-block">$ {req.command}</pre>}
                  {req.diff && <pre className="diff-block">{req.diff}</pre>}
                  <div className="approval-actions">
                    <button className="btn primary sm" onClick={() => void handleApproval(req.id, true, "once")}>
                      {t("approval.allowOnce")}
                    </button>
                    <button className="btn sm" onClick={() => void handleApproval(req.id, true, "session")}>
                      {t("approval.allowSession")}
                    </button>
                    <button className="btn danger sm" onClick={() => void handleApproval(req.id, false)}>
                      {t("approval.deny")}
                    </button>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {compareThreadId && (() => {
              const cmpThread = state.threads.find((th) => th.id === compareThreadId);
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
                    <span>
                      {t("feed.compare", {
                        title: cmpThread?.title ?? "",
                        profile: cmpThread?.profileId ?? "",
                        host: cmpThread?.hostId ?? "",
                      })}
                    </span>
                    <button className="btn ghost xs" onClick={() => setCompareThreadId(null)}>×</button>
                  </div>
                  {cmpBlocks.map((cb) => (
                    <div key={cb.id} className={`msg ${cb.kind === "user_message" ? "user" : "assistant"}`}>
                      <div className="msg-label">{cb.kind === "user_message" ? t("feed.you") : cmpThread?.profileId}</div>
                      {cb.kind === "user_message" ? (
                        <pre className="msg-text">{cb.text}</pre>
                      ) : (
                        <MarkdownContent
                          className={cb.kind === "thought_delta" ? "md-muted" : undefined}
                          content={cb.text}
                          copyLabel={t("common.copy")}
                          copiedLabel={t("common.copied")}
                        />
                      )}
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
                  <span>{t("drawer.title")}</span>
                  <button className="btn ghost xs" onClick={() => setShowSubagentDrawer(false)}>
                    {t("drawer.close")}
                  </button>
                </div>
                {state.blueprints.map((bp) => {
                  const ov = subagentOverrides[bp.name] ?? {
                    enabled: true,
                    profileId: bp.defaultProfileId ?? "",
                    model: bp.defaultModel ?? "",
                    effort: bp.defaultEffort,
                  };
                  const update = (patch: Partial<SubagentOverride>) =>
                    setSubagentOverrides((prev) => ({
                      ...prev,
                      [bp.name]: { ...ov, ...patch },
                    }));
                  const effectiveProf = ov.profileId
                    ? state.profiles.find((p) => p.id === ov.profileId)
                    : activeProfile;
                  const effectiveCat = findCatalogForProfile(state.catalogs, effectiveProf);
                  const rowOptions = buildProfileModelOptions(effectiveCat, effectiveProf);
                  const effectiveModelId =
                    ov.model || (!ov.profileId ? selectedModel : undefined) || undefined;
                  const rowEffortCaps = resolveEffortCapabilities(effectiveCat, effectiveModelId);
                  const currentEffortValue =
                    ov.effort && rowEffortCaps.efforts.includes(ov.effort) ? ov.effort : "";

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
                          const nextProfId = e.target.value;
                          const nextProf = nextProfId
                            ? state.profiles.find((x) => x.id === nextProfId)
                            : activeProfile;
                          const nextCat = findCatalogForProfile(state.catalogs, nextProf);
                          const keepModel =
                            ov.model && nextCat && findModelInCatalog(nextCat, ov.model)
                              ? ov.model
                              : undefined;
                          const nextEffort = coerceEffortForModel(
                            ov.effort ?? "",
                            nextCat,
                            keepModel,
                            true,
                          );
                          update({
                            profileId: nextProfId || undefined,
                            hostId: nextProfId ? nextProf?.hostId : undefined,
                            model: keepModel,
                            effort: nextEffort || undefined,
                          });
                        }}
                      >
                        <option value="">{t("drawer.sameAsMain")}</option>
                        {state.profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.agent}@{p.hostId})
                          </option>
                        ))}
                      </select>
                      <ModelPicker
                        dropUp
                        value={ov.model ?? ""}
                        options={rowOptions}
                        placeholder={t("drawer.modelPlaceholder")}
                        autoLabel={t("picker.autoInherit")}
                        emptyLabel={t("picker.noMatch")}
                        countLabel={pickerCountLabel}
                        onChange={(nextModel) => {
                          const nextEffort = coerceEffortForModel(
                            ov.effort ?? "",
                            effectiveCat,
                            nextModel || (!ov.profileId ? selectedModel : undefined),
                            true,
                          );
                          update({
                            model: nextModel || undefined,
                            effort: nextEffort || undefined,
                          });
                        }}
                      />
                      <select
                        value={currentEffortValue}
                        disabled={rowEffortCaps.efforts.length === 0}
                        onChange={(e) =>
                          update({
                            effort: (e.target.value as ThinkingEffort) || undefined,
                          })
                        }
                      >
                        <option value="">
                          {rowEffortCaps.efforts.length === 0
                            ? t("picker.effortModelDefault")
                            : t("picker.effortInherit")}
                        </option>
                        {rowEffortCaps.efforts.map((ef) => (
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
                placeholder={t("composer.placeholder")}
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
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const nextProf = state.profiles.find((p) => p.id === nextId);
                    const nextCat = findCatalogForProfile(state.catalogs, nextProf);
                    setSelectedProfileId(nextId);
                    const keepModel =
                      selectedModel && nextCat && findModelInCatalog(nextCat, selectedModel)
                        ? selectedModel
                        : "";
                    setSelectedModel(keepModel);
                    setSelectedEffort(
                      coerceEffortForModel(selectedEffort, nextCat, keepModel, false),
                    );
                  }}
                  title={t("composer.profileTooltip")}
                >
                  {state.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.agent}@{p.hostId})
                    </option>
                  ))}
                </select>

                <ModelPicker
                  dropUp
                  className="composer-model-picker"
                  value={selectedModel}
                  options={mainModelOptions}
                  placeholder={
                    activeCatalog
                      ? t("composer.modelLive", { count: activeCatalog.models.length })
                      : t("composer.modelAuto")
                  }
                  autoLabel={t("picker.autoInherit")}
                  emptyLabel={t("picker.noMatch")}
                  countLabel={pickerCountLabel}
                  onChange={(nextModel) => {
                    setSelectedModel(nextModel);
                    setSelectedEffort(
                      coerceEffortForModel(selectedEffort, activeCatalog, nextModel, false),
                    );
                  }}
                />

                <select
                  value={availableEfforts.includes(selectedEffort as ThinkingEffort) ? selectedEffort : ""}
                  disabled={availableEfforts.length === 0}
                  onChange={(e) => setSelectedEffort((e.target.value as ThinkingEffort) || "")}
                  title={t("composer.effortTooltip")}
                >
                  {availableEfforts.length === 0 ? (
                    <option value="">{t("picker.effortAuto")}</option>
                  ) : (
                    availableEfforts.map((ef) => (
                      <option key={ef} value={ef}>
                        {t("composer.effortLabel", { level: ef })}
                      </option>
                    ))
                  )}
                </select>

                <select
                  className={
                    selectedMode === "full-access"
                      ? "mode-select mode-full-access"
                      : selectedMode === "workspace-full"
                        ? "mode-select mode-workspace-full"
                        : "mode-select"
                  }
                  value={selectedMode}
                  onChange={(e) => setSelectedMode(e.target.value)}
                  title={t("composer.modeTooltip")}
                >
                  <option value="plan">{t("composer.modePlan")}</option>
                  <option value="default">{t("composer.modeAsk")}</option>
                  <option value="accept-edits">{t("composer.modeAcceptEdits")}</option>
                  <option value="auto">{t("composer.modeAuto")}</option>
                  <option value="workspace-full">{t("composer.modeWorkspaceFull")}</option>
                  <option value="full-access">{t("composer.modeFullAccess")}</option>
                </select>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={quotaSaver}
                    onChange={(e) => setQuotaSaver(e.target.checked)}
                  />
                  <span>{t("composer.quotaSaver")}</span>
                </label>

                <button className="btn ghost sm" onClick={() => setShowSubagentDrawer((v) => !v)}>
                  {t("composer.subagents")}
                </button>

                {activeThread.status === "running" || activeThread.status === "waiting_approval" ? (
                  <button
                    className="btn danger sm"
                    onClick={() => void handleCancelThread(activeThread.id)}
                  >
                    {cancellingThreads[activeThread.id]
                      ? t("composer.stopping")
                      : t("composer.cancel")}
                  </button>
                ) : (
                  <button className="btn primary sm" onClick={() => void handleSendPrompt()}>
                    {t("composer.send")}
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
            {t("inspector.tabDiff", { count: diffState.files.length })}
          </button>
          <button className={inspectorTab === "terminal" ? "active" : ""} onClick={() => setInspectorTab("terminal")}>
            {t("inspector.tabTerminal")}
          </button>
          <button className={inspectorTab === "quota" ? "active" : ""} onClick={() => setInspectorTab("quota")}>
            {t("inspector.tabQuota")}
          </button>
        </div>

        {inspectorTab === "diff" && (
          <div className="inspector-body">
            <div className="section-head">
              <span>{t("inspector.changedFiles")}</span>
              {activeThreadId && (
                <button className="btn ghost xs" onClick={() => void refreshDiff(activeThreadId)}>
                  {t("inspector.refresh")}
                </button>
              )}
            </div>
            {diffState.files.map((f) => (
              <div key={f.path} className="file-row">
                <span className="badge">{f.status}</span>
                <span>{f.path}</span>
              </div>
            ))}
            <pre className="diff-block">{diffState.diff || t("inspector.cleanTree")}</pre>
            {activeThreadId && diffState.files.length > 0 && (
              <div className="commit-box">
                <input
                  placeholder={t("inspector.commitPlaceholder")}
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                />
                <button
                  className="btn primary sm"
                  onClick={async () => {
                    try {
                      const r = await api<{ sha: string }>(`/api/threads/${activeThreadId}/commit`, {
                        method: "POST",
                        body: JSON.stringify({ message: commitMsg || t("inspector.defaultCommitMsg") }),
                      });
                      setCommitMsg("");
                      notify(t("toast.committed", { sha: r.sha }));
                      void refreshDiff(activeThreadId);
                    } catch (e) {
                      notify(t("toast.commitFailed", { msg: (e as Error).message }));
                    }
                  }}
                >
                  {t("inspector.commit")}
                </button>
              </div>
            )}
          </div>
        )}

        {inspectorTab === "terminal" && (
          <div className="inspector-body">
            <pre className="code-block">
              {(activeThreadId && terminalByThread[activeThreadId]) || t("inspector.noTerminal")}
            </pre>
          </div>
        )}

        {inspectorTab === "quota" && (
          <div className="inspector-body">
            <div className="section-head">
              <span>{t("inspector.remoteQuota")}</span>
              {activeProfile && (
                <button
                  className="btn ghost xs"
                  onClick={async () => {
                    try {
                      await api(`/api/profiles/${activeProfile.id}/refresh-quota`, { method: "POST" });
                      notify(t("toast.checkedQuota", { name: activeProfile.name }));
                    } catch (e) {
                      notify(t("toast.quotaFailed", { msg: (e as Error).message }));
                    }
                  }}
                >
                  {t("inspector.check")}
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
                return <div className="muted-sm">{t("inspector.quotaHint")}</div>;
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
                          <div className="muted-sm">
                            {t("inspector.resets", {
                              time: w.resetsAt.replace("T", " ").slice(0, 19),
                            })}
                          </div>
                        )}
                      </div>
                      <strong>
                        {w.remainingAmount ??
                          (w.remainingPercent !== undefined
                            ? t("inspector.pctLeft", { pct: w.remainingPercent.toFixed(0) })
                            : "—")}
                      </strong>
                    </div>
                  ))}
                  {q.note && <div className="muted-sm" style={{ marginTop: 6 }}>{q.note}</div>}
                </div>
              );
            })()}

            <div className="section-head" style={{ marginTop: 8 }}>
              <span>{t("inspector.tokenUsageHead")}</span>
              <span className="badge">
                {usage?.exact ? t("inspector.exactApi") : t("inspector.estimated")}
              </span>
            </div>
            <div className="quota-stat">
              <div>{t("inspector.primaryTokens")}</div>
              <strong>
                {mainTotal.toLocaleString()} ({(usage?.mainInputTokens ?? 0).toLocaleString()} /{" "}
                {(usage?.mainOutputTokens ?? 0).toLocaleString()})
              </strong>
            </div>
            {(usage?.mainCachedInputTokens ?? 0) > 0 && (
              <div className="quota-stat">
                <div>{t("inspector.cachedTokens")}</div>
                <strong>{(usage?.mainCachedInputTokens ?? 0).toLocaleString()}</strong>
              </div>
            )}
            {(usage?.mainReasoningTokens ?? 0) > 0 && (
              <div className="quota-stat">
                <div>{t("inspector.reasoningTokens")}</div>
                <strong>{(usage?.mainReasoningTokens ?? 0).toLocaleString()}</strong>
              </div>
            )}
            {usage?.totalCostUsd !== undefined && (
              <div className="quota-stat">
                <div>{t("inspector.reportedCost")}</div>
                <strong>${usage.totalCostUsd.toFixed(4)} USD</strong>
              </div>
            )}
            <div className="quota-stat green">
              <div>{t("inspector.offloadedTokens")}</div>
              <strong>{offloadedTotal.toLocaleString()} ({offloadPct}%)</strong>
            </div>
            <div className="muted-sm">{t("inspector.quotaSaverTip")}</div>
          </div>
        )}
      </aside>

      {/* MODALS */}
      {modal === "host" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingHostId ? t("modal.host.editTitle") : t("modal.host.title")}</h3>
            <label>
              {t("modal.host.id")}
              <input
                disabled={Boolean(editingHostId)}
                placeholder="us-vps"
                value={hostDraft.id}
                onChange={(e) => setHostDraft({ ...hostDraft, id: e.target.value })}
              />
            </label>
            <label>
              {t("modal.host.name")}
              <input
                placeholder="Tailnet Remote Node"
                value={hostDraft.name}
                onChange={(e) => setHostDraft({ ...hostDraft, name: e.target.value })}
              />
            </label>
            <label>
              {t("modal.host.transport")}
              <select
                value={hostDraft.transport}
                onChange={(e) => setHostDraft({ ...hostDraft, transport: e.target.value })}
              >
                <option value="tailnet-direct">{t("modal.host.transportTailnet")}</option>
                <option value="tailscale-ssh">{t("modal.host.transportTailscaleSsh")}</option>
                <option value="openssh">{t("modal.host.transportOpenssh")}</option>
                <option value="local">{t("modal.host.transportLocal")}</option>
              </select>
            </label>
            {hostDraft.transport === "tailnet-direct" && (
              <label>
                {t("modal.host.endpoint")}
                <input
                  placeholder="wss://<host>.<tailnet>.ts.net/v1/ws"
                  value={hostDraft.endpoint}
                  onChange={(e) => setHostDraft({ ...hostDraft, endpoint: e.target.value })}
                />
                <span className="field-hint">{t("modal.host.endpointHint")}</span>
              </label>
            )}
            {(hostDraft.transport === "tailscale-ssh" || hostDraft.transport === "openssh") && (
              <label>
                {t("modal.host.sshTarget")}
                <input
                  placeholder="dev@us-vps"
                  value={hostDraft.sshTarget}
                  onChange={(e) => setHostDraft({ ...hostDraft, sshTarget: e.target.value })}
                />
              </label>
            )}
            {hostDraft.transport === "tailnet-direct" && (
              <>
                <label>
                  {t("modal.host.authMode")}
                  <select
                    value={hostDraft.authMode}
                    onChange={(e) => setHostDraft({ ...hostDraft, authMode: e.target.value })}
                  >
                    <option value="tailscale-serve">{t("modal.host.authServe")}</option>
                    <option value="tailscaled-whois">{t("modal.host.authWhois")}</option>
                    <option value="dev-token">{t("modal.host.authToken")}</option>
                  </select>
                </label>
                {hostDraft.authMode === "dev-token" && (
                  <label>
                    {t("modal.host.bearerToken")}
                    <input
                      type="password"
                      placeholder={
                        editingHostId && hostDraft.hasBearerToken
                          ? t("modal.host.bearerTokenKeepHint")
                          : ""
                      }
                      value={hostDraft.bearerToken}
                      onChange={(e) => setHostDraft({ ...hostDraft, bearerToken: e.target.value })}
                    />
                  </label>
                )}
              </>
            )}
            <div className="modal-actions">
              {editingHostId && (() => {
                const target = state.hosts.find((x) => x.id === editingHostId);
                return target ? (
                  <>
                    <button
                      className="btn danger"
                      onClick={() => void handleDeleteHost(target)}
                    >
                      {t("modal.host.delete")}
                    </button>
                    <span className="spacer" />
                  </>
                ) : null;
              })()}
              <button className="btn" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button
                className="btn primary"
                onClick={async () => {
                  const hostId = hostDraft.id.trim();
                  if (!hostId) return notify(t("toast.hostIdRequired"));
                  const hostName = hostDraft.name.trim() || hostId;
                  try {
                    const r = await api<{ ok: boolean; state?: HubStateSnapshot }>("/api/hosts", {
                      method: "POST",
                      body: JSON.stringify({
                        id: hostId,
                        name: hostName,
                        transport: hostDraft.transport,
                        endpoint: hostDraft.endpoint.trim(),
                        sshTarget: hostDraft.sshTarget.trim() || undefined,
                        authMode: hostDraft.authMode,
                        bearerToken:
                          hostDraft.authMode === "dev-token"
                            ? hostDraft.bearerToken.trim() || undefined
                            : undefined,
                        maxSessions: hostDraft.maxSessions,
                      }),
                    });
                    if (r.state) applyStateSnapshot(r.state);
                    setModal(null);
                    setEditingHostId(null);
                    notify(t("toast.savedHost", { name: hostName }));
                    if (hostDraft.transport === "tailnet-direct" && hostDraft.endpoint.trim()) {
                      void handleProbeHost(hostId, hostName);
                    }
                  } catch (e) {
                    notify(t("toast.saveFailed", { msg: (e as Error).message }));
                  }
                }}
              >
                {t("modal.host.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "profile" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingProfileId ? t("modal.profile.editTitle") : t("modal.profile.title")}</h3>
            <label>
              {t("modal.profile.id")}
              <input
                disabled={Boolean(editingProfileId)}
                placeholder="remote-agy"
                value={profileDraft.id}
                onChange={(e) => setProfileDraft({ ...profileDraft, id: e.target.value })}
              />
            </label>
            <label>
              {t("modal.profile.name")}
              <input
                placeholder="Antigravity"
                value={profileDraft.name}
                onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
              />
            </label>
            <label>
              {t("modal.profile.host")}
              <select
                value={profileDraft.hostId}
                onChange={(e) => setProfileDraft({ ...profileDraft, hostId: e.target.value })}
              >
                {state.hosts.map((h) => (
                  <option key={h.id} value={h.id}>{h.name} ({h.id})</option>
                ))}
              </select>
            </label>
            <label>
              {t("modal.profile.agent")}
              <select
                value={profileDraft.agent}
                onChange={(e) => {
                  const nextAgent = e.target.value;
                  setProfileDraft((prev) => ({
                    ...prev,
                    agent: nextAgent,
                    remoteBin:
                      !editingProfileId &&
                      (!prev.remoteBin || prev.remoteBin === DEFAULT_BIN_BY_AGENT[prev.agent])
                        ? (DEFAULT_BIN_BY_AGENT[nextAgent] ?? prev.remoteBin)
                        : prev.remoteBin,
                  }));
                }}
              >
                <option value="antigravity">Antigravity CLI (agy)</option>
                <option value="opencode">OpenCode (opencode)</option>
                <option value="claude">Claude Code (claude)</option>
                <option value="codex">Codex CLI (codex)</option>
                <option value="gemini">Gemini CLI (gemini)</option>
                <option value="kiro">Kiro CLI (kiro-cli)</option>
                <option value="factory-droid">Factory Droid (droid)</option>
              </select>
            </label>
            <label>
              {t("modal.profile.remoteBin")}
              <input value={profileDraft.remoteBin} onChange={(e) => setProfileDraft({ ...profileDraft, remoteBin: e.target.value })} />
            </label>
            <label>
              {t("modal.profile.defaultModel")}
              <ModelPicker
                value={profileDraft.defaultModel}
                options={profileModalModelOptions}
                placeholder={
                  profileModalCatalog
                    ? t("composer.modelLive", { count: profileModalCatalog.models.length })
                    : t("composer.modelAuto")
                }
                autoLabel={t("picker.autoInherit")}
                emptyLabel={t("picker.noMatch")}
                countLabel={pickerCountLabel}
                onChange={(nextModel) =>
                  setProfileDraft({ ...profileDraft, defaultModel: nextModel })
                }
              />
            </label>
            <div className="modal-actions">
              {editingProfileId && (() => {
                const target = state.profiles.find((x) => x.id === editingProfileId);
                return target ? (
                  <>
                    <button
                      className="btn danger"
                      onClick={() => void handleDeleteProfile(target)}
                    >
                      {t("modal.profile.delete")}
                    </button>
                    <span className="spacer" />
                  </>
                ) : null;
              })()}
              <button className="btn" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button
                className="btn primary"
                onClick={async () => {
                  const profId = profileDraft.id.trim();
                  const targetHostId = profileDraft.hostId || state.hosts[0]?.id || "";
                  if (!profId || !targetHostId) return notify(t("toast.profileIdRequired"));
                  const profName = profileDraft.name.trim() || profId;
                  try {
                    const r = await api<{ ok: boolean; state?: HubStateSnapshot }>("/api/profiles", {
                      method: "POST",
                      body: JSON.stringify({
                        ...profileDraft,
                        id: profId,
                        name: profName,
                        hostId: targetHostId,
                      }),
                    });
                    if (r.state) applyStateSnapshot(r.state);
                    setModal(null);
                    setEditingProfileId(null);
                    notify(t("toast.savedProfile", { name: profName }));
                  } catch (e) {
                    notify(t("toast.saveFailed", { msg: (e as Error).message }));
                  }
                }}
              >
                {t("modal.profile.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "thread" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("modal.thread.title")}</h3>
            <label>
              {t("modal.thread.name")}
              <input value={threadDraft.title} onChange={(e) => setThreadDraft({ ...threadDraft, title: e.target.value })} />
            </label>
            <label>
              {t("modal.thread.workspace")}
              <input value={threadDraft.workspaceRoot} onChange={(e) => setThreadDraft({ ...threadDraft, workspaceRoot: e.target.value })} />
            </label>
            <label>
              {t("modal.thread.profile")}
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
              <span>{t("modal.thread.worktree")}</span>
            </label>
            {threadDraft.createWorktree && (
              <label>
                {t("modal.thread.branch")}
                <input value={threadDraft.branchName} onChange={(e) => setThreadDraft({ ...threadDraft, branchName: e.target.value })} />
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={threadDraft.ephemeralRemote}
                onChange={(e) => setThreadDraft({ ...threadDraft, ephemeralRemote: e.target.checked })}
              />
              <span>{t("modal.thread.incognito")}</span>
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button
                className="btn primary"
                onClick={async () => {
                  const prof = state.profiles.find((p) => p.id === threadDraft.profileId);
                  if (!prof) return notify(t("toast.selectProfileFirst"));
                  const r = await api<{ thread: HubStateSnapshot["threads"][number] }>("/api/threads", {
                    method: "POST",
                    body: JSON.stringify({
                      title: threadDraft.title || t("modal.thread.defaultTitle"),
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
                {t("modal.thread.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "blueprint" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("modal.blueprint.title")}</h3>
            <label>
              {t("modal.blueprint.name")}
              <input value={blueprintDraft.name} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, name: e.target.value })} />
            </label>
            <label>
              {t("modal.blueprint.desc")}
              <input value={blueprintDraft.description} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, description: e.target.value })} />
            </label>
            <label>
              {t("modal.blueprint.mode")}
              <select
                value={blueprintDraft.executionMode}
                onChange={(e) =>
                  setBlueprintDraft({
                    ...blueprintDraft,
                    executionMode: e.target.value as "auto" | "native" | "federated",
                  })
                }
              >
                <option value="auto">{t("modal.blueprint.modeAuto")}</option>
                <option value="federated">{t("modal.blueprint.modeFederated")}</option>
                <option value="native">{t("modal.blueprint.modeNative")}</option>
              </select>
            </label>
            <label>
              {t("modal.blueprint.profile")}
              <select
                value={blueprintDraft.defaultProfileId}
                onChange={(e) => {
                  const nextProfId = e.target.value;
                  const nextProf = nextProfId
                    ? state.profiles.find((p) => p.id === nextProfId)
                    : primaryProfile;
                  const nextCat = findCatalogForProfile(state.catalogs, nextProf);
                  const keepModel =
                    blueprintDraft.defaultModel &&
                    nextCat &&
                    findModelInCatalog(nextCat, blueprintDraft.defaultModel)
                      ? blueprintDraft.defaultModel
                      : "";
                  const nextEffort = coerceEffortForModel(
                    blueprintDraft.defaultEffort,
                    nextCat,
                    keepModel,
                    true,
                  );
                  setBlueprintDraft({
                    ...blueprintDraft,
                    defaultProfileId: nextProfId,
                    defaultModel: keepModel,
                    defaultEffort: nextEffort,
                  });
                }}
              >
                <option value="">{t("modal.blueprint.inheritMain")}</option>
                {state.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.agent}@{p.hostId})</option>
                ))}
              </select>
            </label>
            <label>
              {t("modal.blueprint.model")}
              <ModelPicker
                value={blueprintDraft.defaultModel}
                options={blueprintModelOptions}
                placeholder={t("drawer.modelPlaceholder")}
                autoLabel={t("picker.autoInherit")}
                emptyLabel={t("picker.noMatch")}
                countLabel={pickerCountLabel}
                onChange={(nextModel, matchedOpt) => {
                  // If user picked a model belonging to another connected agent while on "Inherit Main",
                  // automatically bind defaultProfileId to that model's owning agent so host/model stay aligned.
                  const nextProfId =
                    matchedOpt?.profileId &&
                    !blueprintDraft.defaultProfileId &&
                    matchedOpt.profileId !== primaryProfile?.id
                      ? matchedOpt.profileId
                      : blueprintDraft.defaultProfileId;
                  const nextProf = nextProfId
                    ? state.profiles.find((p) => p.id === nextProfId)
                    : primaryProfile;
                  const nextCat = findCatalogForProfile(state.catalogs, nextProf);
                  const nextEffort = coerceEffortForModel(
                    blueprintDraft.defaultEffort,
                    nextCat,
                    nextModel,
                    true,
                  );
                  setBlueprintDraft({
                    ...blueprintDraft,
                    defaultProfileId: nextProfId,
                    defaultModel: nextModel,
                    defaultEffort: nextEffort,
                  });
                }}
              />
            </label>
            <label>
              {t("modal.blueprint.effort")}
              <select
                value={
                  blueprintDraft.defaultEffort &&
                  blueprintEffortCaps.efforts.includes(blueprintDraft.defaultEffort as ThinkingEffort)
                    ? blueprintDraft.defaultEffort
                    : ""
                }
                disabled={blueprintEffortCaps.efforts.length === 0}
                onChange={(e) =>
                  setBlueprintDraft({
                    ...blueprintDraft,
                    defaultEffort: (e.target.value as ThinkingEffort) || "",
                  })
                }
              >
                <option value="">
                  {blueprintEffortCaps.efforts.length === 0
                    ? t("picker.effortModelDefault")
                    : t("picker.effortInherit")}
                </option>
                {blueprintEffortCaps.efforts.map((ef) => (
                  <option key={ef} value={ef}>{ef}</option>
                ))}
              </select>
            </label>
            <label>
              {t("modal.blueprint.tools")}
              <input value={blueprintDraft.toolsText} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, toolsText: e.target.value })} />
            </label>
            <label>
              {t("modal.blueprint.prompt")}
              <textarea rows={3} value={blueprintDraft.systemPrompt} onChange={(e) => setBlueprintDraft({ ...blueprintDraft, systemPrompt: e.target.value })} />
            </label>
            <div className="modal-actions">
              {blueprintDraft.name && state.blueprints.some((b) => b.name === blueprintDraft.name) && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    await api(`/api/subagents/${encodeURIComponent(blueprintDraft.name)}`, { method: "DELETE" });
                    setModal(null);
                    notify(t("toast.deletedSubagent", { name: blueprintDraft.name }));
                  }}
                >
                  {t("modal.blueprint.delete")}
                </button>
              )}
              <button className="btn" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button
                className="btn primary"
                onClick={async () => {
                  if (!blueprintDraft.name.trim()) return notify(t("toast.subagentNameRequired"));
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
                      defaultEffort: blueprintDraft.defaultEffort || undefined,
                    }),
                  });
                  setModal(null);
                  notify(t("toast.savedSubagent", { name: blueprintDraft.name }));
                }}
              >
                {t("modal.blueprint.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
