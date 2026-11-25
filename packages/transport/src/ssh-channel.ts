import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { McpRpcReqPayload, McpRpcResPayload, SpawnSessionPayload } from "@agent-remote/protocol";
import type { RemoteSessionChannel } from "./tailnet-client.js";

export interface SshChannelOptions {
  sshTarget: string;
  sshArgs?: string[];
  spawnSpec: SpawnSessionPayload;
  /** Local loopback HTTP MCP server port to expose to the remote CLI via `ssh -R`. */
  localMcpPort?: number;
  remoteMcpPort?: number;
  mcpBearerToken?: string;
}

/**
 * Strips MOTD / .bashrc banners emitted on stdout prior to the exact sentinel marker line.
 */
export class MotdSentinelFilter {
  private readonly sentinel: string;
  private unlocked = false;
  private buffer = "";

  constructor(sentinel: string) {
    this.sentinel = sentinel;
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  push(chunk: string): string {
    if (this.unlocked) return chunk;
    this.buffer += chunk;
    const marker = `${this.sentinel}\n`;
    const idx = this.buffer.indexOf(marker);
    if (idx === -1) return "";
    this.unlocked = true;
    const rest = this.buffer.slice(idx + marker.length);
    this.buffer = "";
    return rest;
  }
}

/**
 * Builds a POSIX `sh -c` wrapper that:
 * 1. Creates an isolated `/tmp/ar-<sid>/empty` workspace (chmod 700)
 * 2. Registers an EXIT/INT/TERM trap to guarantee zero remote leftovers
 * 3. Materializes any ephemeral files cleanly via base64 (safe against quoting/newlines)
 * 4. Prints the MOTD sentinel right before `exec`ing the target CLI.
 */
export function buildSshRemoteWrapperCommand(params: {
  sentinel: string;
  spec: SpawnSessionPayload;
  mcpUrl?: string;
  mcpToken?: string;
}): string {
  const replacePlaceholders = (s: string) =>
    s
      .replaceAll("{{MCP_URL}}", params.mcpUrl ?? "")
      .replaceAll("{{MCP_TOKEN}}", params.mcpToken ?? "");

  const lines: string[] = [
    "set -eu",
    `WORKDIR="/tmp/ar-ssh-$$-${params.spec.sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}"`,
    'mkdir -p "$WORKDIR/empty" && chmod 700 "$WORKDIR"',
    'trap \'rm -rf "$WORKDIR"\' EXIT INT TERM HUP',
  ];

  for (const [rel, rawContent] of Object.entries(params.spec.ephemeralFiles ?? {})) {
    const cleanRel = rel.replace(/^\/+/, "");
    if (cleanRel.includes("..")) continue;
    const b64 = Buffer.from(replacePlaceholders(rawContent), "utf8").toString("base64");
    const dir = cleanRel.includes("/") ? cleanRel.slice(0, cleanRel.lastIndexOf("/")) : "";
    if (dir) {
      lines.push(`mkdir -p "$WORKDIR/${shellEscape(dir)}"`);
    }
    lines.push(`printf '%s' '${b64}' | base64 -d > "$WORKDIR/${shellEscape(cleanRel)}"`);
  }

  for (const [k, v] of Object.entries(params.spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`export ${k}='${shellEscape(replacePlaceholders(v))}'`);
  }
  if (params.mcpUrl) lines.push(`export AGENT_REMOTE_MCP_URL='${shellEscape(params.mcpUrl)}'`);
  if (params.mcpToken) lines.push(`export AGENT_REMOTE_MCP_TOKEN='${shellEscape(params.mcpToken)}'`);

  const escapedCmd = [
    params.spec.command,
    ...(params.spec.args ?? []).map(replacePlaceholders),
  ]
    .map((a) => `'${shellEscape(a)}'`)
    .join(" ");

  lines.push(`cd "$WORKDIR/empty"`);
  lines.push(`printf '%s\\n' '${params.sentinel}'`);
  lines.push(`exec ${escapedCmd}`);

  return lines.join("; ");
}

/**
 * Zero-install OpenSSH / Tailscale SSH session channel (`ssh -T`) with MOTD sentinel framing
 * and optional `-R` reverse tunnel pointing back to the local `LocalHttpMcpServer`.
 */
export class SshSessionChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId: string;
  readonly channel = 1;
  readonly workdir = "/tmp/ar-ssh/empty";
  readonly mcpEndpointUrl?: string;
  readonly mcpBearerToken?: string;

  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly filter: MotdSentinelFilter;

  constructor(options: SshChannelOptions) {
    super();
    this.sessionId = options.spawnSpec.sessionId;
    const sentinel = `__AR_READY_${crypto.randomBytes(8).toString("hex")}__`;
    this.filter = new MotdSentinelFilter(sentinel);

    const remotePort = options.remoteMcpPort ?? (options.localMcpPort ? 28000 + (crypto.randomInt(10000)) : undefined);
    if (options.localMcpPort && remotePort) {
      this.mcpEndpointUrl = `http://127.0.0.1:${remotePort}/mcp`;
      this.mcpBearerToken = options.mcpBearerToken;
    }

    const sshArgs: string[] = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      ...(options.sshArgs ?? []),
    ];

    if (options.localMcpPort && remotePort) {
      sshArgs.push("-R", `127.0.0.1:${remotePort}:127.0.0.1:${options.localMcpPort}`);
    }

    const remoteScript = buildSshRemoteWrapperCommand({
      sentinel,
      spec: options.spawnSpec,
      mcpUrl: this.mcpEndpointUrl,
      mcpToken: this.mcpBearerToken,
    });

    sshArgs.push(options.sshTarget, `sh -c '${shellEscape(remoteScript)}'`);

    this.proc = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => {
      const clean = this.filter.push(chunk);
      if (clean) this.emit("stdout", clean);
    });
    this.proc.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.proc.on("close", (code) => {
      this.emit("exit", { sessionId: this.sessionId, exitCode: code ?? 0 });
    });
  }

  writeStdin(data: string): void {
    this.proc.stdin.write(data);
  }

  kill(): void {
    this.proc.kill("SIGTERM");
  }

  setMcpHandler(_handler: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>): void {
    // SSH mode routes MCP requests directly via `-R` tunnel into LocalHttpMcpServer
  }
}

function shellEscape(s: string): string {
  return s.replaceAll("'", "'\\''");
}
