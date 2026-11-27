import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { McpRpcReqPayload, McpRpcResPayload, SpawnSessionPayload } from "@agent-remote/protocol";
import type { RemoteSessionChannel } from "./tailnet-client.js";

export interface SshChannelOptions {
  sshTarget: string;
  transport?: "tailscale-ssh" | "openssh";
  sshArgs?: string[];
  spawnSpec: SpawnSessionPayload;
  /** Local loopback HTTP MCP server port to expose to the remote CLI via `ssh -R`. */
  localMcpPort?: number;
  remoteMcpPort?: number;
  mcpBearerToken?: string;
}

/**
 * Strips MOTD / .bashrc banners emitted on stdout prior to the exact sentinel marker line,
 * and extracts the optional `__AR_WORKDIR__=<path>` metadata line emitted right before the sentinel.
 */
export class MotdSentinelFilter {
  private readonly sentinel: string;
  private unlocked = false;
  private buffer = "";
  private discoveredWorkdir?: string;

  constructor(sentinel: string) {
    this.sentinel = sentinel;
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  getDiscoveredWorkdir(): string | undefined {
    return this.discoveredWorkdir;
  }

  push(chunk: string): string {
    if (this.unlocked) return chunk;
    this.buffer += chunk;
    const match = new RegExp(`${escapeRegExp(this.sentinel)}\\r?\\n`).exec(this.buffer);
    if (!match || match.index === undefined) return "";

    const pre = this.buffer.slice(0, match.index);
    const wdMatch = /__AR_WORKDIR__=([^\r\n]+)/.exec(pre);
    if (wdMatch?.[1]) {
      this.discoveredWorkdir = wdMatch[1].trim();
    }

    this.unlocked = true;
    const rest = this.buffer.slice(match.index + match[0].length);
    this.buffer = "";
    return rest;
  }
}

/**
 * Builds a POSIX `sh -c` wrapper that:
 * 1. Detects Snap-confined CLIs (`/snap/bin/*`) and uses a Snap-shared base directory instead of `/tmp`
 * 2. Creates an isolated `$BASE/ar-ssh-<sid>/empty` workspace (chmod 700)
 * 3. Registers an EXIT/INT/TERM trap to guarantee zero remote leftovers
 * 4. Materializes any ephemeral files cleanly via base64 (safe against quoting/newlines)
 * 5. Emits `__AR_WORKDIR__=<actual path>` + MOTD sentinel right before `exec`ing the target CLI.
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

  const safeSid = params.spec.sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  const cmdName = params.spec.command;

  const lines: string[] = [
    "set -eu",
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/snap/bin:$PATH"',
    `RESOLVED_CMD="$(command -v '${shellEscape(cmdName)}' 2>/dev/null || printf '%s' '${shellEscape(cmdName)}')"`,
    'BASE_DIR="/tmp"',
    'case "$RESOLVED_CMD" in /snap/*|/var/lib/snapd/snap/*) if [ -d "$HOME/snap/antigravity-cli/common" ]; then BASE_DIR="$HOME/snap/antigravity-cli/common/ar-sessions"; else BASE_DIR="$HOME/agent-remote-sessions"; fi ;; esac',
    `WORKDIR="$BASE_DIR/ar-ssh-${safeSid}"`,
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
  lines.push(`printf '__AR_WORKDIR__=%s\\n' "$WORKDIR/empty"`);
  lines.push(`printf '%s\\n' '${params.sentinel}'`);
  lines.push(`exec ${escapedCmd}`);

  return lines.join("; ");
}

/**
 * Zero-install OpenSSH / Tailscale SSH session channel (`ssh -T`) with MOTD sentinel framing
 * and optional `-R` reverse tunnel pointing back to the local `LocalHttpMcpServer`.
 * Note: Tailscale SSH natively intercepts standard `ssh` client connections over Tailnet MagicDNS/IP
 * without SSH keys while preserving OpenSSH `-R` reverse port forwarding (`ExitOnForwardFailure=yes`).
 */
export class SshSessionChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId: string;
  readonly channel = 1;
  readonly mcpEndpointUrl?: string;
  readonly mcpBearerToken?: string;

  private _workdir: string;
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly filter: MotdSentinelFilter;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;

  get workdir(): string {
    return this._workdir;
  }

  constructor(options: SshChannelOptions) {
    super();
    this.sessionId = options.spawnSpec.sessionId;
    const safeSid = this.sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
    this._workdir = `/tmp/ar-ssh-${safeSid}/empty`;

    const sentinel = `__AR_READY_${crypto.randomBytes(8).toString("hex")}__`;
    this.filter = new MotdSentinelFilter(sentinel);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const remotePort =
      options.remoteMcpPort ?? (options.localMcpPort ? 28000 + crypto.randomInt(10000) : undefined);
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
      ...(options.transport === "tailscale-ssh"
        ? ["-o", "StrictHostKeyChecking=accept-new"]
        : []),
      ...(options.sshArgs ?? []),
    ];

    if (options.localMcpPort && remotePort) {
      sshArgs.push(
        "-o",
        "ExitOnForwardFailure=yes",
        "-R",
        `127.0.0.1:${remotePort}:127.0.0.1:${options.localMcpPort}`,
      );
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

    let stderrBuf = "";
    this.proc.stdout.on("data", (chunk: string) => {
      const wasUnlocked = this.filter.isUnlocked();
      const clean = this.filter.push(chunk);
      if (!wasUnlocked && this.filter.isUnlocked()) {
        const discovered = this.filter.getDiscoveredWorkdir();
        if (discovered) this._workdir = discovered;
        this.resolveReady();
      }
      if (clean) this.emit("stdout", clean);
    });
    this.proc.stderr.on("data", (chunk: string) => {
      if (!this.filter.isUnlocked() && stderrBuf.length < 2048) stderrBuf += chunk;
      this.emit("stderr", chunk);
    });
    this.proc.on("error", (err) => {
      if (!this.filter.isUnlocked()) this.rejectReady(err);
    });
    this.proc.on("close", (code) => {
      if (!this.filter.isUnlocked()) {
        this.rejectReady(
          new Error(
            `SSH remote session exited (code ${code ?? -1}) before ready (note: zero-install SSH requires POSIX sh on the remote host; for remote Windows hosts use tailnet-direct agent-remote-node). ${stderrBuf.trim()}`,
          ),
        );
      }
      this.emit("exit", { sessionId: this.sessionId, exitCode: code ?? 0 });
    });
  }

  /** Waits until the remote SSH wrapper prints the MOTD sentinel and synchronizes the actual remote workdir. */
  async waitForReady(timeoutMs = 15_000): Promise<void> {
    if (this.filter.isUnlocked()) return;
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`SSH channel ready timed out after ${timeoutMs}ms`)), timeoutMs).unref(),
      ),
    ]);
  }

  writeStdin(data: string): void {
    this.proc.stdin.write(data);
  }

  kill(): void {
    try {
      this.proc.stdin.destroy();
      this.proc.stdout.destroy();
      this.proc.stderr.destroy();
    } catch {
      // ignore pipe destroy errors
    }
    if (process.platform === "win32" && this.proc.pid) {
      try {
        const killer = spawn("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => {});
        killer.unref();
      } catch {
        // ignore taskkill spawn error
      }
      try {
        this.proc.kill();
      } catch {
        // already exited
      }
    } else {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    this.proc.unref();
  }

  setMcpHandler(_handler: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>): void {
    // SSH mode routes MCP requests directly via `-R` tunnel into LocalHttpMcpServer
  }
}

function shellEscape(s: string): string {
  return s.replaceAll("'", "'\\''");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
