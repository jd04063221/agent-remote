import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline/promises";
import { formatLocalHistoryContext } from "@agent-remote/core";
import {
  attachDriverSession,
  buildSpawnSpecForAgent,
  getDefaultDbPath,
  HubStore,
  type ThreadEventRecord,
  type ThreadRecord,
} from "@agent-remote/hub-server";
import {
  parseAgyModelsOutput,
  type AgentKind,
  type ThinkingEffort,
} from "@agent-remote/protocol";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
  PERMISSION_MODES,
  PolicyEngine,
  WorkspaceSandbox,
  WorktreeManager,
  type PermissionMode,
} from "@agent-remote/tool-plane";
import { TailnetDirectClient } from "@agent-remote/transport";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

export interface ChatSlashAction {
  kind:
    | "help"
    | "models"
    | "model"
    | "effort"
    | "mode"
    | "quota"
    | "usage"
    | "history"
    | "threads"
    | "diff"
    | "exit"
    | "unknown";
  arg?: string;
}

export function parseChatSlashCommand(input: string): ChatSlashAction | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim() || undefined;
  switch (cmd?.toLowerCase()) {
    case "help":
      return { kind: "help" };
    case "models":
      return { kind: "models" };
    case "model":
      return { kind: "model", arg };
    case "effort":
      return { kind: "effort", arg };
    case "mode":
      return { kind: "mode", arg };
    case "quota":
      return { kind: "quota" };
    case "usage":
      return { kind: "usage" };
    case "history":
      return { kind: "history" };
    case "threads":
      return { kind: "threads" };
    case "diff":
      return { kind: "diff" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "unknown", arg: cmd };
  }
}

export function colorizeUnifiedDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return `${ANSI.green}${line}${ANSI.reset}`;
      if (line.startsWith("-") && !line.startsWith("---")) return `${ANSI.red}${line}${ANSI.reset}`;
      if (line.startsWith("@@")) return `${ANSI.cyan}${line}${ANSI.reset}`;
      return line;
    })
    .join("\n");
}

function collapseEventsToTurns(
  events: ThreadEventRecord[],
): Array<{ role: "user" | "assistant"; text: string }> {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const ev of events) {
    if (ev.kind === "user_message" && typeof ev.payload.text === "string") {
      turns.push({ role: "user", text: ev.payload.text });
    } else if (ev.kind === "text_delta" && typeof ev.payload.text === "string") {
      const last = turns[turns.length - 1];
      if (last && last.role === "assistant") {
        last.text += ev.payload.text;
      } else {
        turns.push({ role: "assistant", text: ev.payload.text });
      }
    }
  }
  return turns;
}

export interface InteractiveChatOptions {
  endpoint: string;
  bearerToken?: string;
  hostId?: string;
  profileId?: string;
  agent: AgentKind;
  remoteBin?: string;
  model?: string;
  effort?: ThinkingEffort;
  mode?: PermissionMode;
  cwd: string;
  dbPath?: string;
  noSave?: boolean;
  resumeThreadId?: string;
  title?: string;
  ephemeralRemote?: boolean;
}

export async function runInteractiveChat(options: InteractiveChatOptions): Promise<void> {
  const absCwd = path.resolve(options.cwd);
  const store = options.noSave ? undefined : new HubStore(getDefaultDbPath(options.dbPath));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hostId = options.hostId ?? "cli-host";
  const profileId = options.profileId ?? `cli-${options.agent}`;

  let thread: ThreadRecord | undefined;
  let priorEvents: ThreadEventRecord[] = [];
  let effectiveCwd = absCwd;
  let currentModel = options.model;
  let currentEffort = options.effort;
  let ephemeralRemote = Boolean(options.ephemeralRemote);

  if (store) {
    if (options.resumeThreadId) {
      const existing = store.getThread(options.resumeThreadId);
      if (!existing) {
        store.close();
        rl.close();
        throw new Error(`Thread "${options.resumeThreadId}" not found in local SQLite history.`);
      }
      thread = existing;
      priorEvents = store.listEvents(existing.id);
      effectiveCwd = existing.worktreePath || absCwd;
      currentModel = currentModel ?? existing.model;
      currentEffort = currentEffort ?? existing.effort;
      ephemeralRemote = options.ephemeralRemote ?? existing.ephemeralRemote;
    } else {
      if (!store.getHost(hostId)) {
        store.upsertHost({
          id: hostId,
          name: hostId,
          transport: "tailnet-direct",
          endpoint: options.endpoint,
          authMode: options.bearerToken ? "dev-token" : "tailscale-serve",
          bearerToken: options.bearerToken,
          maxSessions: 8,
        });
      }
      if (!store.getProfile(profileId)) {
        store.upsertProfile({
          id: profileId,
          name: `${options.agent} @ ${hostId}`,
          hostId,
          agent: options.agent,
          remoteBin: options.remoteBin,
          defaultModel: currentModel,
          defaultEffort: currentEffort,
        });
      }
      const now = new Date().toISOString();
      thread = {
        id: `thr_${crypto.randomBytes(6).toString("hex")}`,
        title: options.title ?? `CLI: ${options.agent} (${path.basename(absCwd)})`,
        workspaceRoot: absCwd,
        worktreePath: absCwd,
        branch: "main",
        hostId,
        profileId,
        model: currentModel,
        effort: currentEffort,
        mode: options.mode ?? "default",
        quotaSaverMode: false,
        remoteSessionId: undefined,
        ephemeralRemote,
        subagentOverrides: {},
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
      store.upsertThread(thread);
    }
  }

  const client = new TailnetDirectClient({
    hostId,
    endpoint: options.endpoint,
    bearerToken: options.bearerToken,
  });

  console.log(`${ANSI.cyan}Connecting to ${options.endpoint}...${ANSI.reset}`);
  const ack = await client.connect();
  const rtt = await client.ping();

  const initialMode = options.mode ?? (thread?.mode as PermissionMode) ?? "default";
  const policy = new PolicyEngine({ mode: initialMode });
  const sandbox = new WorkspaceSandbox({
    workspaceRoot: effectiveCwd,
    allowOutsideWorkspace: initialMode === "full-access",
  });

  const engine = new LocalToolEngine({
    sandbox,
    policy,
    onApprovalNeeded: async (req) => {
      console.log(
        `\n${ANSI.yellow}${ANSI.bold}[Approval Required] ${req.toolName}${ANSI.reset} ${ANSI.dim}(${req.target})${ANSI.reset}`,
      );
      if (req.command) console.log(`${ANSI.cyan}$ ${req.command}${ANSI.reset}`);
      if (req.diff) console.log(colorizeUnifiedDiff(req.diff));
      const answer = (
        await rl.question(
          `${ANSI.yellow}[y] Allow once  [a] Allow session  [n] Deny > ${ANSI.reset}`,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") return { approved: true, scope: "once" };
      if (answer === "a" || answer === "always") return { approved: true, scope: "session" };
      return { approved: false, reason: "Denied in terminal prompt" };
    },
  });

  const mcp = new McpJsonRpcHandler(engine);
  const sessionId = `${thread?.id ?? `chat_${crypto.randomBytes(4).toString("hex")}`}-${crypto.randomBytes(2).toString("hex")}`;

  const localHistoryContext = formatLocalHistoryContext(priorEvents);
  const willAttemptNativeResume = Boolean(thread?.remoteSessionId && !ephemeralRemote);

  const built = buildSpawnSpecForAgent({
    sessionId,
    hostId,
    profileId,
    agent: options.agent,
    remoteBin: options.remoteBin,
    localWorkspaceRoot: effectiveCwd,
    model: currentModel,
    effort: currentEffort,
    resumeRemoteSessionId: willAttemptNativeResume ? thread?.remoteSessionId : undefined,
    ephemeralRemote,
    quotaSaverPrompt:
      !willAttemptNativeResume && localHistoryContext ? localHistoryContext : undefined,
    nativePlans: [],
  });

  const ch = await client.spawnSession(built.spawn);
  ch.setMcpHandler((req) =>
    mcp.handleRpc(req, {
      sessionId,
      onTerminalOutput: (chunk) => process.stdout.write(`${ANSI.dim}${chunk}${ANSI.reset}`),
    }),
  );

  const driver = await attachDriverSession({
    agent: options.agent,
    hostId,
    profileId,
    sessionId,
    channel: ch,
    toolEngine: engine,
    model: currentModel,
    effort: currentEffort,
    resumeRemoteSessionId: willAttemptNativeResume ? thread?.remoteSessionId : undefined,
    ephemeralRemote,
    systemPromptAppend: built.systemPromptAppend,
    developerInstructions: built.developerInstructions,
  });

  if (thread && store && !ephemeralRemote) {
    const rsid = driver.getRemoteSessionId?.();
    if (rsid && rsid !== thread.remoteSessionId) {
      thread.remoteSessionId = rsid;
      store.upsertThread(thread);
    }
    driver.onRemoteSessionId?.((updatedRsid) => {
      if (thread && store && updatedRsid !== thread.remoteSessionId) {
        thread.remoteSessionId = updatedRsid;
        store.upsertThread(thread);
      }
    });
  }

  let pendingHistoryPrefix =
    willAttemptNativeResume && !driver.resumedRemote && localHistoryContext
      ? localHistoryContext
      : undefined;

  let inThought = false;
  let turnReceivedExactUsage = false;
  let turnEstOutput = 0;

  driver.onEvent((ev) => {
    if (ev.type === "usage_delta") {
      turnReceivedExactUsage = true;
      if (thread && store) {
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
        store.upsertThread(thread);
      }
      return;
    }

    if (ev.type === "thought_delta" && ev.text) {
      if (!inThought) {
        process.stdout.write(`${ANSI.dim}[thinking] `);
        inThought = true;
      }
      process.stdout.write(ev.text);
      if (thread && store) {
        store.appendEvent(thread.id, "thought_delta", { text: ev.text });
      }
    } else if (ev.type === "text_delta" && ev.text) {
      if (inThought) {
        process.stdout.write(`${ANSI.reset}\n`);
        inThought = false;
      }
      process.stdout.write(ev.text);
      turnEstOutput += Math.ceil(ev.text.length / 4);
      if (thread && store) {
        store.appendEvent(thread.id, "text_delta", { text: ev.text });
      }
    }
  });

  console.log(
    `${ANSI.green}${ANSI.bold}agent-remote chat${ANSI.reset} | node=${ack.hostname} (${rtt}ms) | agent=${options.agent} | local=${effectiveCwd}`,
  );
  if (thread) {
    const modeTag = ephemeralRemote
      ? "incognito-remote"
      : driver.resumedRemote
        ? "resumed-remote"
        : priorEvents.length > 0
          ? "restored-local-context"
          : "saved-local";
    console.log(
      `${ANSI.dim}Thread: ${thread.id} (${modeTag}) — shared with Web UI (` +
        `ar chat --resume ${thread.id})${ANSI.reset}`,
    );
  }
  if (priorEvents.length > 0) {
    const recentTurns = collapseEventsToTurns(priorEvents).slice(-4);
    console.log(`${ANSI.dim}--- Recent local history (${recentTurns.length} messages) ---${ANSI.reset}`);
    for (const t of recentTurns) {
      const label = t.role === "user" ? `${ANSI.cyan}You:${ANSI.reset}` : `${ANSI.green}Agent:${ANSI.reset}`;
      const preview = t.text.length > 260 ? `${t.text.slice(0, 260)}...` : t.text;
      console.log(`${label} ${preview}`);
    }
    console.log(`${ANSI.dim}----------------------------------------${ANSI.reset}`);
  }
  console.log(`${ANSI.dim}Type /help for slash commands, /exit to quit.${ANSI.reset}\n`);

  const wt = new WorktreeManager(effectiveCwd);

  try {
    while (true) {
      const promptLabel = `${ANSI.cyan}[${options.agent}${currentModel ? `:${currentModel}` : ""}${currentEffort ? `/${currentEffort}` : ""} | ${policy.getMode()}]>${ANSI.reset} `;
      const line = await rl.question(promptLabel);
      const trimmed = line.trim();
      if (!trimmed) continue;

      const slash = parseChatSlashCommand(trimmed);
      if (slash) {
        if (slash.kind === "exit") break;
        if (slash.kind === "help") {
          console.log(
            [
              "/models           List live remote models and supported efforts",
              "/model <id>       Switch model for next turns",
              "/effort <level>   Switch thinking effort (low|medium|high|xhigh|max)",
              `/mode <mode>      Switch local permission mode (${PERMISSION_MODES.join("|")})`,
              "/quota            Query remote remaining quota / balance (incl. live Codex RPC)",
              "/usage            Show exact/estimated token usage for this thread",
              "/history          Show locally saved transcript for this thread",
              "/threads          List recent threads saved in local SQLite (shared with Web UI)",
              "/diff             Show local git diff",
              "/exit             Quit session",
            ].join("\n"),
          );
          continue;
        }
        if (slash.kind === "model") {
          if (!slash.arg) console.log(`Current model: ${currentModel ?? "(default)"}`);
          else {
            currentModel = slash.arg;
            if (thread && store) {
              thread.model = currentModel;
              store.upsertThread(thread);
            }
            console.log(`${ANSI.green}Model set to ${currentModel}${ANSI.reset}`);
          }
          continue;
        }
        if (slash.kind === "effort") {
          if (!slash.arg) console.log(`Current effort: ${currentEffort ?? "(default)"}`);
          else {
            currentEffort = slash.arg as ThinkingEffort;
            if (thread && store) {
              thread.effort = currentEffort;
              store.upsertThread(thread);
            }
            console.log(`${ANSI.green}Thinking effort set to ${currentEffort}${ANSI.reset}`);
          }
          continue;
        }
        if (slash.kind === "mode") {
          if (slash.arg && (PERMISSION_MODES as readonly string[]).includes(slash.arg)) {
            const nextMode = slash.arg as PermissionMode;
            policy.setMode(nextMode);
            sandbox.setAllowOutsideWorkspace(nextMode === "full-access");
            if (thread && store) {
              thread.mode = nextMode;
              store.upsertThread(thread);
            }
            console.log(`${ANSI.green}Permission mode set to ${nextMode}${ANSI.reset}`);
          } else {
            console.log(`Current mode: ${policy.getMode()} (valid: ${PERMISSION_MODES.join("|")})`);
          }
          continue;
        }
        if (slash.kind === "models") {
          const raw = await client.discoverCatalogRaw(options.agent, options.remoteBin);
          if (options.agent === "antigravity") {
            for (const m of parseAgyModelsOutput(raw.rawOutput)) {
              console.log(`  ${m.id.padEnd(30)} efforts=[${m.capabilities.supportedEfforts.join(",")}]`);
            }
          } else {
            console.log(raw.rawOutput || raw.error || "(no CLI model output)");
          }
          continue;
        }
        if (slash.kind === "quota") {
          const live = driver.readQuota ? await driver.readQuota().catch(() => undefined) : undefined;
          const q = live ?? (await client.fetchQuota(options.agent, options.remoteBin));
          console.log(
            `Quota (${q.source}): available=${q.available}${q.planTier ? ` tier=${q.planTier}` : ""}`,
          );
          for (const w of q.windows) {
            const val =
              w.remainingAmount ??
              (w.remainingPercent !== undefined ? `${w.remainingPercent.toFixed(1)}% left` : "?");
            console.log(`  - ${w.label}: ${val}${w.resetsAt ? ` (resets ${w.resetsAt})` : ""}`);
          }
          if (q.note) console.log(`${ANSI.dim}${q.note}${ANSI.reset}`);
          if (store && live) store.upsertQuota(live);
          continue;
        }
        if (slash.kind === "usage") {
          if (!thread) {
            console.log("(Local persistence disabled via --no-save)");
          } else {
            const u = thread.usage;
            console.log(
              `Token Usage (${u.exact ? "exact" : "estimated"}): input=${u.mainInputTokens.toLocaleString()} output=${u.mainOutputTokens.toLocaleString()}` +
                (u.mainCachedInputTokens ? ` cached=${u.mainCachedInputTokens.toLocaleString()}` : "") +
                (u.mainReasoningTokens ? ` reasoning=${u.mainReasoningTokens.toLocaleString()}` : "") +
                (u.totalCostUsd !== undefined ? ` cost=$${u.totalCostUsd.toFixed(4)}` : ""),
            );
          }
          continue;
        }
        if (slash.kind === "history") {
          if (!thread || !store) {
            console.log("(No local SQLite store attached)");
          } else {
            const turns = collapseEventsToTurns(store.listEvents(thread.id));
            if (turns.length === 0) console.log("(Empty conversation history)");
            for (const t of turns) {
              const label = t.role === "user" ? `${ANSI.cyan}You:${ANSI.reset}` : `${ANSI.green}Agent:${ANSI.reset}`;
              console.log(`${label} ${t.text}\n`);
            }
          }
          continue;
        }
        if (slash.kind === "threads") {
          if (!store) {
            console.log("(No local SQLite store attached)");
          } else {
            const list = store.listThreads().slice(0, 15);
            for (const t of list) {
              const marker = t.id === thread?.id ? "*" : " ";
              console.log(
                `${marker} ${t.id}  ${t.profileId.padEnd(16)}  ${t.ephemeralRemote ? "[incognito] " : ""}${t.title} (${t.updatedAt.slice(0, 19)})`,
              );
            }
          }
          continue;
        }
        if (slash.kind === "diff") {
          if (await wt.isGitRepo()) {
            const d = await wt.getDiff(effectiveCwd);
            console.log(d ? colorizeUnifiedDiff(d) : "(working tree clean)");
          } else {
            console.log("(not a git repository)");
          }
          continue;
        }
        console.log(`${ANSI.yellow}Unknown command /${slash.arg}; try /help${ANSI.reset}`);
        continue;
      }

      if (thread && store) {
        store.appendEvent(thread.id, "user_message", {
          text: trimmed,
          model: currentModel,
          effort: currentEffort,
        });
        thread.status = "running";
        thread.updatedAt = new Date().toISOString();
        store.upsertThread(thread);
      }

      inThought = false;
      turnReceivedExactUsage = false;
      turnEstOutput = 0;

      let effectivePrompt = trimmed;
      if (pendingHistoryPrefix) {
        effectivePrompt = `${pendingHistoryPrefix}\n\n${trimmed}`;
        pendingHistoryPrefix = undefined;
      }

      await driver.prompt(effectivePrompt, { model: currentModel, effort: currentEffort });
      if (inThought) {
        process.stdout.write(ANSI.reset);
        inThought = false;
      }
      process.stdout.write("\n\n");

      if (thread && store) {
        if (!ephemeralRemote) {
          const rsid = driver.getRemoteSessionId?.();
          if (rsid) thread.remoteSessionId = rsid;
        }
        if (!turnReceivedExactUsage) {
          thread.usage.mainInputTokens += Math.ceil(trimmed.length / 4);
          thread.usage.mainOutputTokens += turnEstOutput;
        }
        thread.status = "idle";
        thread.updatedAt = new Date().toISOString();
        store.upsertThread(thread);
        store.appendEvent(thread.id, "turn_completed", { stopReason: "end_turn" });
      }
    }
  } finally {
    rl.close();
    ch.kill();
    client.close();
    store?.close();
  }
}
