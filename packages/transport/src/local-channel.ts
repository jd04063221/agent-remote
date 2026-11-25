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
    this.workdir =
      options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "ar-local-sess-"));
    this.mcpEndpointUrl = options.mcpEndpointUrl;
    this.mcpBearerToken = options.mcpBearerToken;

    this.proc = spawn(options.command, options.args ?? [], {
      cwd: this.workdir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => this.emit("stdout", chunk));
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
    // Local process uses loopback HTTP MCP directly if configured
  }
}
