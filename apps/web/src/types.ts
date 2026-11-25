export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface HostState {
  id: string;
  name: string;
  transport: "tailnet-direct" | "tailscale-ssh" | "openssh" | "local";
  endpoint: string;
  authMode: "tailscale-serve" | "tailscaled-whois" | "dev-token" | "none";
  maxSessions: number;
  connected: boolean;
  rttMs?: number;
  activeSessions: number;
  probe?: {
    hostname: string;
    os: string;
    arch: string;
    agents: Array<{
      agent: string;
      binary: string;
      installed: boolean;
      version?: string;
    }>;
  };
}

export interface ProfileState {
  id: string;
  name: string;
  hostId: string;
  agent: string;
  remoteBin?: string;
  defaultModel?: string;
  defaultEffort?: ThinkingEffort;
}

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  source: string;
  isDefault?: boolean;
  capabilities: {
    supportsThinking: boolean;
    supportedEfforts: ThinkingEffort[];
    defaultEffort?: ThinkingEffort;
  };
}

export interface CatalogSnapshot {
  hostId: string;
  profileId: string;
  agent: string;
  tierName?: string;
  currentModelId?: string;
  models: ModelCatalogEntry[];
  fetchedAt: string;
}

export interface SubagentBlueprint {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  executionMode: "auto" | "native" | "federated";
  defaultHostId?: string;
  defaultProfileId?: string;
  defaultModel?: string;
  defaultEffort?: ThinkingEffort;
}

export interface SubagentOverride {
  enabled: boolean;
  executionMode?: "auto" | "native" | "federated";
  hostId?: string;
  profileId?: string;
  model?: string;
  effort?: ThinkingEffort;
}

export interface ThreadState {
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
  subagentOverrides: Record<string, SubagentOverride>;
  usage: {
    mainInputTokens: number;
    mainOutputTokens: number;
    offloadedInputTokens: number;
    offloadedOutputTokens: number;
  };
  status: "idle" | "running" | "waiting_approval" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface ThreadEvent {
  id: number;
  threadId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  action: string;
  toolName: string;
  target: string;
  summary: string;
  diff?: string;
  command?: string;
}

export interface HubStateSnapshot {
  hosts: HostState[];
  profiles: ProfileState[];
  catalogs: CatalogSnapshot[];
  blueprints: SubagentBlueprint[];
  threads: ThreadState[];
  pendingApprovals: ApprovalRequest[];
}
