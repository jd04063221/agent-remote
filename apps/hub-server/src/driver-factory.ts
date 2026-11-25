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
} from "@agent-remote/driver-codex";
import { buildFactoryDroidSpawnSpec } from "@agent-remote/driver-factory-droid";
import { buildGeminiSpawnSpec } from "@agent-remote/driver-gemini";
import { buildKiroSpawnSpec } from "@agent-remote/driver-kiro";
import { buildOpenCodeSpawnSpec } from "@agent-remote/driver-opencode";
import type {
  AgentKind,
  CatalogSnapshot,
  SpawnSessionPayload,
  ThinkingEffort,
} from "@agent-remote/protocol";
import type { ResolvedSubagentPlan } from "@agent-remote/subagent-orchestrator";
import type { LocalToolEngine } from "@agent-remote/tool-plane";
import type { RemoteSessionChannel } from "@agent-remote/transport";

export interface UnifiedDriverSession {
  readonly agent: AgentKind;
  onEvent(cb: (ev: { type: string; text?: string }) => void): void;
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
  systemPromptAppend?: string;
  developerInstructions?: string;
}): Promise<UnifiedDriverSession> {
  if (params.agent === "claude") {
    const claude = new ClaudeStreamSession(params.channel, params.sessionId);
    return {
      agent: "claude",
      onEvent: (cb) => claude.on("event", cb),
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
    await codex.startThread({
      model: params.model,
      effort: params.effort,
      developerInstructions: params.developerInstructions,
    });
    return {
      agent: "codex",
      onEvent: (cb) => codex.on("event", cb),
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
  const sessNew = await acp.startSession({
    systemPromptAppend: params.systemPromptAppend,
  });

  const initialCatalog: CatalogSnapshot = {
    ...acp.extractCatalogSnapshot(
      params.hostId,
      params.profileId,
      params.agent === "opencode" ? "opencode" : "antigravity",
      sessNew,
    ),
    agent: params.agent,
  };

  return {
    agent: params.agent,
    onEvent: (cb) => acp.on("event", cb),
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
