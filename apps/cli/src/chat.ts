import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline/promises";
import {
  attachDriverSession,
  buildSpawnSpecForAgent,
} from "@agent-remote/hub-server";
import {
  parseAgyModelsOutput,
  type AgentKind,
  type ThinkingEffort,
} from "@agent-remote/protocol";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
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

export interface InteractiveChatOptions {
  endpoint: string;
  bearerToken?: string;
  agent: AgentKind;
  remoteBin?: string;
  model?: string;
  effort?: ThinkingEffort;
  mode?: PermissionMode;
  cwd: string;
}

export async function runInteractiveChat(options: InteractiveChatOptions): Promise<void> {
  const absCwd = path.resolve(options.cwd);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const client = new TailnetDirectClient({
    hostId: "chat",
    endpoint: options.endpoint,
    bearerToken: options.bearerToken,
  });

  console.log(`${ANSI.cyan}Connecting to ${options.endpoint}...${ANSI.reset}`);
  const ack = await client.connect();
  const rtt = await client.ping();

  let currentModel = options.model;
  let currentEffort = options.effort;
  const policy = new PolicyEngine({ mode: options.mode ?? "default" });
  const sandbox = new WorkspaceSandbox({ workspaceRoot: absCwd });

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
  const sessionId = `chat_${crypto.randomBytes(4).toString("hex")}`;

  const built = buildSpawnSpecForAgent({
    sessionId,
    hostId: "chat",
    profileId: options.agent,
    agent: options.agent,
    remoteBin: options.remoteBin,
    localWorkspaceRoot: absCwd,
    model: currentModel,
    effort: currentEffort,
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
    hostId: "chat",
    profileId: options.agent,
    sessionId,
    channel: ch,
    toolEngine: engine,
    model: currentModel,
    effort: currentEffort,
    systemPromptAppend: built.systemPromptAppend,
    developerInstructions: built.developerInstructions,
  });

  let inThought = false;
  driver.onEvent((ev) => {
    if (ev.type === "thought_delta" && ev.text) {
      if (!inThought) {
        process.stdout.write(`${ANSI.dim}[thinking] `);
        inThought = true;
      }
      process.stdout.write(ev.text);
    } else if (ev.type === "text_delta" && ev.text) {
      if (inThought) {
        process.stdout.write(`${ANSI.reset}\n`);
        inThought = false;
      }
      process.stdout.write(ev.text);
    }
  });

  console.log(
    `${ANSI.green}${ANSI.bold}agent-remote chat${ANSI.reset} | node=${ack.hostname} (${rtt}ms) | agent=${options.agent} | local=${absCwd}`,
  );
  console.log(`${ANSI.dim}Type /help for slash commands, /exit to quit.${ANSI.reset}\n`);

  const wt = new WorktreeManager(absCwd);

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
              "/mode <mode>      Switch local permission mode (default|accept-edits|auto|plan)",
              "/quota            Query remote remaining quota/balance",
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
            console.log(`${ANSI.green}Model set to ${currentModel}${ANSI.reset}`);
          }
          continue;
        }
        if (slash.kind === "effort") {
          if (!slash.arg) console.log(`Current effort: ${currentEffort ?? "(default)"}`);
          else {
            currentEffort = slash.arg as ThinkingEffort;
            console.log(`${ANSI.green}Thinking effort set to ${currentEffort}${ANSI.reset}`);
          }
          continue;
        }
        if (slash.kind === "mode") {
          if (slash.arg && ["default", "accept-edits", "auto", "plan"].includes(slash.arg)) {
            policy.setMode(slash.arg as PermissionMode);
            console.log(`${ANSI.green}Permission mode set to ${slash.arg}${ANSI.reset}`);
          } else {
            console.log(`Current mode: ${policy.getMode()} (valid: default|accept-edits|auto|plan)`);
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
          const q = await client.fetchQuota(options.agent, options.remoteBin);
          console.log(`Quota (${q.source}): available=${q.available}${q.planTier ? ` tier=${q.planTier}` : ""}`);
          for (const w of q.windows) {
            console.log(`  - ${w.label}: ${w.remainingAmount ?? `${w.remainingPercent ?? "?"}% left`}`);
          }
          if (q.note) console.log(`${ANSI.dim}${q.note}${ANSI.reset}`);
          continue;
        }
        if (slash.kind === "diff") {
          if (await wt.isGitRepo()) {
            const d = await wt.getDiff(absCwd);
            console.log(d ? colorizeUnifiedDiff(d) : "(working tree clean)");
          } else {
            console.log("(not a git repository)");
          }
          continue;
        }
        console.log(`${ANSI.yellow}Unknown command /${slash.arg}; try /help${ANSI.reset}`);
        continue;
      }

      inThought = false;
      await driver.prompt(trimmed, { model: currentModel, effort: currentEffort });
      if (inThought) {
        process.stdout.write(ANSI.reset);
        inThought = false;
      }
      process.stdout.write("\n\n");
    }
  } finally {
    rl.close();
    ch.kill();
    client.close();
  }
}
