import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  AgentKindSchema,
  SubagentExecutionModeSchema,
  ThinkingEffortSchema,
  TransportModeSchema,
} from "@agent-remote/protocol";

const HostEntrySchema = z.object({
  name: z.string().optional(),
  transport: z.union([TransportModeSchema, z.literal("local")]).default("tailnet-direct"),
  endpoint: z.string().default(""),
  auth: z
    .enum(["tailscale-serve", "tailscaled-whois", "dev-token", "none"])
    .default("tailscale-serve"),
  bearer_token: z.string().optional(),
  ssh_target: z.string().optional(),
  ssh_args: z.array(z.string()).default([]),
  max_concurrent_sessions: z.number().int().positive().default(8),
});

const ProfileEntrySchema = z.object({
  name: z.string().optional(),
  host: z.string(),
  agent: AgentKindSchema,
  remote_bin: z.string().optional(),
  default_model: z.string().optional(),
  default_effort: ThinkingEffortSchema.optional(),
});

const SubagentEntrySchema = z.object({
  description: z.string().default("Custom subagent"),
  system_prompt: z.string().default(""),
  tools: z.array(z.string()).default(["read_file", "grep", "glob", "list_dir"]),
  execution_mode: SubagentExecutionModeSchema.default("auto"),
  default_host: z.string().optional(),
  default_profile: z.string().optional(),
  default_model: z.string().optional(),
  default_effort: ThinkingEffortSchema.optional(),
});

const TaskPresetSchema = z.object({
  main_profile: z.string(),
  main_model: z.string().optional(),
  main_effort: ThinkingEffortSchema.optional(),
  quota_saver_mode: z.boolean().default(false),
  subagents: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        profile: z.string().optional(),
        host: z.string().optional(),
        model: z.string().optional(),
        effort: ThinkingEffortSchema.optional(),
        mode: SubagentExecutionModeSchema.optional(),
      }),
    )
    .default({}),
});

const LocalMcpEntrySchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const AgentRemoteConfigSchema = z.object({
  hub: z
    .object({
      bind: z.string().default("127.0.0.1:3775"),
      expose_over_tailscale: z.boolean().default(false),
      default_profile: z.string().optional(),
      db_path: z.string().optional(),
      ephemeral_remote: z.boolean().default(false),
    })
    .default({}),
  hosts: z.record(z.string(), HostEntrySchema).default({}),
  profiles: z.record(z.string(), ProfileEntrySchema).default({}),
  subagents: z.record(z.string(), SubagentEntrySchema).default({}),
  task_presets: z.record(z.string(), TaskPresetSchema).default({}),
  permissions: z
    .object({
      default_mode: z.enum(["default", "accept-edits", "auto", "plan"]).default("default"),
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({}),
  local_mcp: z.record(z.string(), LocalMcpEntrySchema).default({}),
});

export type AgentRemoteConfig = z.infer<typeof AgentRemoteConfigSchema>;

export function getDefaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "agent-remote", "config.toml");
}

export function parseConfigToml(raw: string): AgentRemoteConfig {
  const parsed = parseToml(raw);
  return AgentRemoteConfigSchema.parse(parsed);
}

/**
 * Loads global `~/.config/agent-remote/config.toml` and merges optional project-local `.agent-remote.toml`.
 */
export function loadAgentRemoteConfig(options?: {
  globalPath?: string;
  projectDir?: string;
}): AgentRemoteConfig {
  const globalPath = options?.globalPath ?? getDefaultConfigPath();
  let merged: AgentRemoteConfig = AgentRemoteConfigSchema.parse({});

  if (fs.existsSync(globalPath)) {
    const raw = fs.readFileSync(globalPath, "utf8");
    merged = parseConfigToml(raw);
  }

  if (options?.projectDir) {
    const projPath = path.join(options.projectDir, ".agent-remote.toml");
    if (fs.existsSync(projPath)) {
      const proj = parseConfigToml(fs.readFileSync(projPath, "utf8"));
      merged = {
        hub: { ...merged.hub, ...proj.hub },
        hosts: { ...merged.hosts, ...proj.hosts },
        profiles: { ...merged.profiles, ...proj.profiles },
        subagents: { ...merged.subagents, ...proj.subagents },
        task_presets: { ...merged.task_presets, ...proj.task_presets },
        permissions: {
          default_mode: proj.permissions.default_mode ?? merged.permissions.default_mode,
          allow: [...merged.permissions.allow, ...proj.permissions.allow],
          ask: [...merged.permissions.ask, ...proj.permissions.ask],
          deny: [...merged.permissions.deny, ...proj.permissions.deny],
        },
        local_mcp: { ...merged.local_mcp, ...proj.local_mcp },
      };
    }
  }

  return merged;
}

/**
 * Parses compact permission rule syntax such as `command(git status*)`, `write(.git/**)`, `read(**)`.
 */
export function parsePermissionRuleExpr(
  expr: string,
  decision: "allow" | "ask" | "deny",
): { action: "read" | "search" | "write" | "delete" | "command" | "mcp" | "*"; pattern: string; decision: "allow" | "ask" | "deny" } | null {
  const m = /^(read|search|write|delete|command|mcp|\*)\((.+)\)$/.exec(expr.trim());
  if (!m) return null;
  return {
    action: m[1] as "read" | "search" | "write" | "delete" | "command" | "mcp" | "*",
    pattern: m[2]!.trim(),
    decision,
  };
}

export const STARTER_CONFIG_TOML = `[hub]
bind = "127.0.0.1:3775"
expose_over_tailscale = false
default_profile = "us-agy"
ephemeral_remote = false

[hosts.us-vps]
name = "US Tailnet VPS"
transport = "tailnet-direct"
endpoint = "wss://us-vps.your-tailnet.ts.net/v1/ws"
auth = "tailscale-serve"
max_concurrent_sessions = 8

[profiles.us-agy]
name = "Antigravity @ US"
host = "us-vps"
agent = "antigravity"
remote_bin = "agy"
default_effort = "high"

[profiles.us-opencode]
name = "OpenCode DeepSeek Pool @ US"
host = "us-vps"
agent = "opencode"
remote_bin = "opencode"
default_model = "deepseek/deepseek-4.1-flash"

[subagents.explorer]
description = "Fast codebase scan offloaded to DeepSeek to save closed-source quota"
system_prompt = "Locate relevant files and symbols quickly; return concise summaries."
tools = ["read_file", "grep", "glob", "list_dir"]
execution_mode = "federated"
default_profile = "us-opencode"
default_model = "deepseek/deepseek-4.1-flash"
default_effort = "low"

[task_presets.agy-quota-saver]
main_profile = "us-agy"
main_effort = "xhigh"
quota_saver_mode = true
[task_presets.agy-quota-saver.subagents]
explorer = { profile = "us-opencode", model = "deepseek/deepseek-4.1-flash", effort = "low", mode = "federated" }

[permissions]
default_mode = "default"
allow = ["read(**)", "search(**)", "command(git status*)", "command(git diff*)"]
deny = ["write(.git/**)", "command(rm -rf /*)", "command(sudo *)"]
`;
