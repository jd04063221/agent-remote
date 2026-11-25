import {
  AcpRemoteSession,
  buildAntigravitySpawnSpec,
} from "@agent-remote/driver-antigravity";
import {
  buildClaudeSpawnSpec,
  ClaudeStreamSession,
} from "@agent-remote/driver-claude";
import {
  buildCodexSpawnSpec,
  CodexAppServerSession,
  parseCodexRateLimits,
} from "@agent-remote/driver-codex";
import { buildFactoryDroidSpawnSpec } from "@agent-remote/driver-factory-droid";
import { buildGeminiSpawnSpec } from "@agent-remote/driver-gemini";
import { buildKiroSpawnSpec } from "@agent-remote/driver-kiro";
import { buildOpenCodeSpawnSpec } from "@agent-remote/driver-opencode";
import type {
  AgentKind,
  CatalogSnapshot,
  QuotaSnapshot,
  SpawnSessionPayload,
  ThinkingEffort,
} from "@agent-remote/protocol";
import type { ResolvedSubagentPlan } from "@agent-remote/subagent-orchestrator";
import {
  LocalToolEngine,
  PolicyEngine,
  WorkspaceSandbox,
} from "@agent-remote/tool-plane";
import type { RemoteSessionChannel } from "@agent-remote/transport";

export interface DriverEventPayload {
  type: string;
  text?: string;
  toolName?: string;
  status?: string;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  exact?: boolean;
}

export interface UnifiedDriverSession {
  readonly agent: AgentKind;
  readonly resumedRemote: boolean;
  onEvent(cb: (ev: DriverEventPayload) => void): void;
  onRemoteSessionId?: (cb: (remoteSessionId: string) => void) => void;
  onQuota?: (cb: (snapshot: QuotaSnapshot) => void) => void;
  getRemoteSessionId?: () => string | undefined;
  readQuota?: () => Promise<QuotaSnapshot | undefined>;
  prompt(text: string, opts?: { model?: string; effort?: ThinkingEffort }): Promise<void>;
  cancel(): void;
  getInitialCatalog?: () => CatalogSnapshot | undefined;
}

export interface DriverBootstrapInput {
  sessionId: string;
  hostId: string;
  profileId: string;
  agent: AgentKind;
  remoteBin?: string;
  localWorkspaceRoot: string;
  localGitBranch?: string;
  model?: string;
  effort?: ThinkingEffort;
  resumeRemoteSessionId?: string;
  ephemeralRemote?: boolean;
  quotaSaverPrompt?: string;
  pureInferenceOnly?: boolean;
  nativePlans: ResolvedSubagentPlan[];
}

export function buildSpawnSpecForAgent(input: DriverBootstrapInput): {
  spawn: SpawnSessionPayload;
  systemPromptAppend?: string;
  developerInstructions?: string;
} {
  const nativeSubagents = input.nativePlans
    .filter((p) => p.enabled && p.track === "native")
    .map((p) => ({
      blueprint: p.blueprint,
      model: p.model,
      effort: p.effort,
    }));

  switch (input.agent) {
    case "antigravity":
      return buildAntigravitySpawnSpec({
        sessionId: input.sessionId,
        remoteBin: input.remoteBin,
        localWorkspaceRoot: input.localWorkspaceRoot,
        localGitBranch: input.localGitBranch,
        quotaSaverPrompt: input.quotaSaverPrompt,
        enableMcpBridge: !input.pureInferenceOnly,
      });

    case "opencode":
      return {
        spawn: buildOpenCodeSpawnSpec({
          sessionId: input.sessionId,
          remoteBin: input.remoteBin,
          model: input.model,
          pureInferenceOnly: input.pureInferenceOnly,
          enableMcpBridge: !input.pureInferenceOnly,
        }),
      };

    case "claude":
      return {
        spawn: buildClaudeSpawnSpec({
          sessionId: input.sessionId,
          remoteBin: input.remoteBin,
          model: input.model,
          effort: input.effort,
          resumeRemoteSessionId: input.resumeRemoteSessionId,
          ephemeralRemote: input.ephemeralRemote,
          localWorkspaceRoot: input.localWorkspaceRoot,
          localGitBranch: input.localGitBranch,
          quotaSaverPrompt: input.quotaSaverPrompt,
          nativeSubagents,
        }),
      };

    case "codex":
      return buildCodexSpawnSpec({
        sessionId: input.sessionId,
        remoteBin: input.remoteBin,
        model: input.model,
        effort: input.effort,
        ephemeralRemote: input.ephemeralRemote,
        localWorkspaceRoot: input.localWorkspaceRoot,
        quotaSaverPrompt: input.quotaSaverPrompt,
        nativeSubagents,
      });

    case "gemini":
      return {
        spawn: buildGeminiSpawnSpec({
          sessionId: input.sessionId,
          remoteBin: input.remoteBin,
          model: input.model,
          nativeSubagents: nativeSubagents.map((s) => ({
            blueprint: s.blueprint,
            model: s.model,
          })),
        }),
      };

    case "kiro":
      return {
        spawn: buildKiroSpawnSpec({
          sessionId: input.sessionId,
          remoteBin: input.remoteBin,
          model: input.model,
          effort: input.effort,
          localWorkspaceRoot: input.localWorkspaceRoot,
          quotaSaverPrompt: input.quotaSaverPrompt,
          nativeSubagents,
        }),
      };

    case "factory-droid":
      return {
        spawn: buildFactoryDroidSpawnSpec({
          sessionId: input.sessionId,
          remoteBin: input.remoteBin,
          model: input.model,
          effort: input.effort,
          nativeSubagents,
        }),
      };
  }
}

export async function attachDriverSession(params: {
  agent: AgentKind;
  hostId: string;
  profileId: string;
  sessionId: string;
  channel: RemoteSessionChannel;
  toolEngine: LocalToolEngine;
  model?: string;
  effort?: ThinkingEffort;
  resumeRemoteSessionId?: string;
  ephemeralRemote?: boolean;
  systemPromptAppend?: string;
  developerInstructions?: string;
}): Promise<UnifiedDriverSession> {
  if (params.agent === "claude") {
    const claude = new ClaudeStreamSession(params.channel, params.sessionId);
    return {
      agent: "claude",
      resumedRemote: Boolean(params.resumeRemoteSessionId && !params.ephemeralRemote),
      onEvent: (cb) => claude.on("event", cb),
      onRemoteSessionId: (cb) => claude.on("remote_session_id", cb),
      getRemoteSessionId: () => claude.getRemoteSessionId(),
      prompt: (text) => claude.prompt(text),
      cancel: () => claude.cancel(),
    };
  }

  if (params.agent === "codex") {
    const codex = new CodexAppServerSession(
      params.channel,
      params.toolEngine,
      params.sessionId,
    );
    await codex.initialize();
    let initialCatalog: CatalogSnapshot | undefined;
    try {
      const models = await codex.listModels();
      if (models.length > 0) {
        initialCatalog = {
          hostId: params.hostId,
          profileId: params.profileId,
          agent: "codex",
          models,
          fetchedAt: new Date().toISOString(),
        };
      }
    } catch {
      // Optional live model list
    }
    const started = await codex.resumeOrStartThread({
      resumeThreadId: params.resumeRemoteSessionId,
      ephemeral: params.ephemeralRemote,
      model: params.model,
      effort: params.effort,
      developerInstructions: params.developerInstructions,
    });
    return {
      agent: "codex",
      resumedRemote: started.resumed,
      onEvent: (cb) => codex.on("event", cb),
      onQuota: (cb) =>
        codex.on("quota_raw", (raw) =>
          cb(parseCodexRateLimits(raw, params.hostId, params.profileId)),
        ),
      getRemoteSessionId: () => codex.getRemoteSessionId(),
      readQuota: () => codex.readRateLimits(params.hostId, params.profileId),
      prompt: (text, opts) => codex.prompt(text, opts),
      cancel: () => codex.cancel(),
      getInitialCatalog: () => initialCatalog,
    };
  }

  // Unified ACP v1 agents: antigravity, opencode, gemini, kiro, factory-droid
  const acp = new AcpRemoteSession({
    channel: params.channel,
    toolEngine: params.toolEngine,
    sessionId: params.sessionId,
    blockRemoteBuiltins: true,
  });
  await acp.initialize();
  const started = await acp.resumeOrStartSession({
    resumeSessionId: params.ephemeralRemote ? undefined : params.resumeRemoteSessionId,
    systemPromptAppend: params.systemPromptAppend,
  });

  const initialCatalog: CatalogSnapshot = {
    ...acp.extractCatalogSnapshot(
      params.hostId,
      params.profileId,
      params.agent === "opencode" ? "opencode" : "antigravity",
      started.result,
    ),
    agent: params.agent,
  };

  return {
    agent: params.agent,
    resumedRemote: started.resumed,
    onEvent: (cb) => acp.on("event", cb),
    getRemoteSessionId: () => acp.getRemoteSessionId(),
    prompt: async (text, opts) => {
      try {
        await acp.setModelAndEffort(opts?.model, opts?.effort);
      } catch {
        // Some ACP backends lock model/effort at startup
      }
      await acp.prompt(text);
    },
    cancel: () => acp.cancel(),
    getInitialCatalog: () => (initialCatalog.models.length > 0 ? initialCatalog : undefined),
  };
}

/**
 * Performs a lightweight one-shot `codex app-server` `account/rateLimits/read` query over a remote channel.
 */
export async function probeCodexRateLimitsOverChannel(params: {
  hostId: string;
  profileId: string;
  sessionId: string;
  channel: RemoteSessionChannel;
  cwd?: string;
}): Promise<QuotaSnapshot> {
  const dummyEngine = new LocalToolEngine({
    sandbox: new WorkspaceSandbox({ workspaceRoot: params.cwd ?? process.cwd(), readOnly: true }),
    policy: new PolicyEngine({ mode: "plan" }),
  });
  const codex = new CodexAppServerSession(params.channel, dummyEngine, params.sessionId);
  await codex.initialize();
  return await codex.readRateLimits(params.hostId, params.profileId);
}
