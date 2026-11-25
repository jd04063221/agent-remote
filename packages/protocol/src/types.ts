import { z } from "zod";

export const AGENT_KINDS = [
  "antigravity",
  "opencode",
  "claude",
  "codex",
  "gemini",
  "kiro",
  "factory-droid",
] as const;

export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const THINKING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const ThinkingEffortSchema = z.enum(THINKING_EFFORTS);
export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>;

export const TRANSPORT_MODES = [
  "tailnet-direct",
  "tailscale-ssh",
  "openssh",
] as const;

export const TransportModeSchema = z.enum(TRANSPORT_MODES);
export type TransportMode = z.infer<typeof TransportModeSchema>;

export const ModelParamOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type ModelParamOption = z.infer<typeof ModelParamOptionSchema>;

export const ModelParamSchema = z.object({
  id: z.string(),
  category: z.enum(["model", "thought_level", "mode", "custom"]),
  label: z.string(),
  type: z.enum(["select", "boolean", "number"]),
  options: z.array(ModelParamOptionSchema).optional(),
  defaultValue: z.union([z.string(), z.boolean(), z.number()]).optional(),
});
export type ModelParam = z.infer<typeof ModelParamSchema>;

export const ModelCatalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  source: z.enum(["live-rpc", "cli-probe", "custom-byok", "fallback"]),
  isDefault: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  /** Maps canonical effort level -> concrete backend model slug when effort is encoded in model ID (e.g. agy). */
  effortVariantMap: z.partialRecord(ThinkingEffortSchema, z.string()).optional(),
  inputModalities: z.array(z.enum(["text", "image", "audio", "pdf"])).optional(),
  contextWindow: z.number().int().positive().optional(),
  capabilities: z.object({
    supportsThinking: z.boolean(),
    supportedEfforts: z.array(ThinkingEffortSchema),
    defaultEffort: ThinkingEffortSchema.optional(),
    extraParams: z.array(ModelParamSchema).optional(),
  }),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const CatalogSnapshotSchema = z.object({
  hostId: z.string(),
  profileId: z.string(),
  agent: AgentKindSchema,
  tierName: z.string().optional(),
  currentModelId: z.string().optional(),
  models: z.array(ModelCatalogEntrySchema),
  extraConfigOptions: z.array(ModelParamSchema).optional(),
  fetchedAt: z.string(),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

export const SubagentExecutionModeSchema = z.enum(["auto", "native", "federated"]);
export type SubagentExecutionMode = z.infer<typeof SubagentExecutionModeSchema>;

export const SubagentBlueprintSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string().default(""),
  tools: z.array(z.string()).default(["read_file", "grep", "glob", "list_dir"]),
  executionMode: SubagentExecutionModeSchema.default("auto"),
  defaultHostId: z.string().optional(),
  defaultProfileId: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultEffort: ThinkingEffortSchema.optional(),
});
export type SubagentBlueprint = z.infer<typeof SubagentBlueprintSchema>;

export const SubagentTaskOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  executionMode: SubagentExecutionModeSchema.optional(),
  hostId: z.string().optional(),
  profileId: z.string().optional(),
  model: z.string().optional(),
  effort: ThinkingEffortSchema.optional(),
});
export type SubagentTaskOverride = z.infer<typeof SubagentTaskOverrideSchema>;

export const TaskOverrideSchema = z.object({
  hostId: z.string(),
  profileId: z.string(),
  mainModel: z.string().optional(),
  mainEffort: ThinkingEffortSchema.optional(),
  mode: z.string().optional(),
  quotaSaverMode: z.boolean().default(false),
  subagents: z.record(z.string(), SubagentTaskOverrideSchema).default({}),
});
export type TaskOverride = z.infer<typeof TaskOverrideSchema>;

export const TokenUsageBreakdownSchema = z.object({
  mainInputTokens: z.number().int().nonnegative().default(0),
  mainOutputTokens: z.number().int().nonnegative().default(0),
  mainCachedInputTokens: z.number().int().nonnegative().default(0),
  mainReasoningTokens: z.number().int().nonnegative().default(0),
  offloadedInputTokens: z.number().int().nonnegative().default(0),
  offloadedOutputTokens: z.number().int().nonnegative().default(0),
  totalCostUsd: z.number().nonnegative().optional(),
  exact: z.boolean().default(false),
});
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdownSchema>;

export const QuotaWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number().min(0).max(100).optional(),
  remainingPercent: z.number().min(0).max(100).optional(),
  remainingAmount: z.string().optional(),
  resetsAt: z.string().optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const QuotaSnapshotSchema = z.object({
  hostId: z.string(),
  profileId: z.string(),
  agent: AgentKindSchema,
  available: z.boolean(),
  source: z.enum(["oauth-api", "app-server-rpc", "provider-balance", "cli-probe", "unavailable"]),
  planTier: z.string().optional(),
  windows: z.array(QuotaWindowSchema).default([]),
  note: z.string().optional(),
  fetchedAt: z.string(),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

/**
 * Multiplexed WebSocket wire envelope shared between Local Hub (TS) and apps/remote-node (Go).
 * Channel 0 is the node control plane; channels >= 1 carry isolated remote agent sessions.
 */
export const MUX_FRAME_TYPES = [
  "hello",
  "hello_ack",
  "ping",
  "pong",
  "probe_req",
  "probe_res",
  "catalog_req",
  "catalog_res",
  "quota_req",
  "quota_res",
  "spawn_session",
  "session_ready",
  "session_resume",
  "session_stdin",
  "session_stdout",
  "session_stderr",
  "session_kill",
  "session_exit",
  "mcp_rpc_req",
  "mcp_rpc_res",
  "error",
] as const;

export const MuxFrameTypeSchema = z.enum(MUX_FRAME_TYPES);
export type MuxFrameType = z.infer<typeof MuxFrameTypeSchema>;

export const MuxFrameSchema = z.object({
  ch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  type: MuxFrameTypeSchema,
  payload: z.unknown().optional(),
});
export type MuxFrame = z.infer<typeof MuxFrameSchema>;

export const SpawnSessionPayloadSchema = z.object({
  sessionId: z.string().min(1),
  agent: AgentKindSchema,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Files materialized into the session's ephemeral isolated directory before launching the CLI. */
  ephemeralFiles: z.record(z.string(), z.string()).default({}),
  enableMcpBridge: z.boolean().default(true),
});
export type SpawnSessionPayload = z.infer<typeof SpawnSessionPayloadSchema>;

export const SessionReadyPayloadSchema = z.object({
  sessionId: z.string(),
  channel: z.number().int().positive(),
  workdir: z.string(),
  mcpEndpointUrl: z.string().optional(),
  mcpBearerToken: z.string().optional(),
});
export type SessionReadyPayload = z.infer<typeof SessionReadyPayloadSchema>;

export const McpRpcReqPayloadSchema = z.object({
  rpcId: z.string(),
  sessionId: z.string(),
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string(),
});
export type McpRpcReqPayload = z.infer<typeof McpRpcReqPayloadSchema>;

export const McpRpcResPayloadSchema = z.object({
  rpcId: z.string(),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string(),
});
export type McpRpcResPayload = z.infer<typeof McpRpcResPayloadSchema>;
