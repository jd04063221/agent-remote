import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpRpcReqPayload, McpRpcResPayload } from "@agent-remote/protocol";
import type { RemoteSessionChannel } from "./tailnet-client.js";

/**
 * Local child-process session channel for running drivers against CLIs installed directly on this machine
 * (or over SSH when using zero-install Tailscale SSH / OpenSSH mode).
 */
export class LocalProcessChannel extends EventEmitter implements RemoteSessionChannel {
  readonly sessionId: string;
  readonly channel = 1;
  readonly workdir: string;
  readonly mcpEndpointUrl?: string;
  readonly mcpBearerToken?: string;

  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly ownsWorkdir: boolean;

  constructor(options: {
    sessionId: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    mcpEndpointUrl?: string;
    mcpBearerToken?: string;
  }) {
    super();
    this.sessionId = options.sessionId;
    this.ownsWorkdir = !options.cwd;
    this.workdir =
      options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "ar-local-sess-"));
    this.mcpEndpointUrl = options.mcpEndpointUrl;
    this.mcpBearerToken = options.mcpBearerToken;

    const needsWinShell =
      process.platform === "win32" && !options.command.toLowerCase().endsWith(".exe");
    const spawnCmd =
      needsWinShell && options.command.includes(" ")
        ? `"${options.command}"`
        : options.command;
    this.proc = spawn(spawnCmd, options.args ?? [], {
      cwd: this.workdir,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: needsWinShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => this.emit("stdout", chunk));
    this.proc.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.proc.on("error", (err: Error) => {
      this.emit("stderr", err.message);
      this.cleanupWorkdir();
      this.emit("exit", { sessionId: this.sessionId, exitCode: -1, error: err.message });
    });
    this.proc.on("close", (code) => {
      this.cleanupWorkdir();
      this.emit("exit", { sessionId: this.sessionId, exitCode: code ?? 0 });
    });
  }

  private cleanupWorkdir(): void {
    if (!this.ownsWorkdir) return;
    try {
      fs.rmSync(this.workdir, { recursive: true, force: true });
    } catch {
      // ignore cleanup race on Windows
    }
  }

  writeStdin(data: string): void {
    this.proc.stdin.write(data);
  }

  kill(): void {
    if (process.platform === "win32" && this.proc.pid) {
      spawn("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      this.proc.kill("SIGTERM");
    }
  }

  setMcpHandler(_handler: (req: McpRpcReqPayload) => Promise<McpRpcResPayload>): void {
    // Local process uses loopback HTTP MCP directly if configured
  }
}
