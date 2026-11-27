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
    agent?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    ephemeralRemote?: boolean;
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

    const launchArgs = [...(options.args ?? [])];
    const launchEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(options.env ?? {}),
    };

    if (options.ephemeralRemote && this.ownsWorkdir) {
      applyLocalEphemeralIsolation(options.agent, this.workdir, launchArgs, launchEnv);
    }

    const needsWinShell =
      process.platform === "win32" && !options.command.toLowerCase().endsWith(".exe");
    const spawnCmd =
      needsWinShell && options.command.includes(" ")
        ? `"${options.command}"`
        : options.command;
    this.proc = spawn(spawnCmd, launchArgs, {
      cwd: this.workdir,
      env: launchEnv,
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

function linkOrCopyEntry(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  try {
    const stat = fs.statSync(src);
    fs.symlinkSync(src, dst, stat.isDirectory() ? "junction" : "file");
  } catch {
    try {
      const stat = fs.statSync(src);
      if (stat.isFile()) {
        fs.copyFileSync(src, dst);
      }
    } catch {
      // ignore non-critical optional entry
    }
  }
}

function applyLocalEphemeralIsolation(
  agent: string | undefined,
  workdir: string,
  args: string[],
  env: Record<string, string | undefined>,
): void {
  const home = os.homedir();
  if (!home) return;

  if (agent === "opencode") {
    const srcBase = process.env.XDG_DATA_HOME?.trim()
      ? path.join(process.env.XDG_DATA_HOME.trim(), "opencode")
      : path.join(home, ".local", "share", "opencode");
    const ephemXdg = path.join(workdir, ".ephem-xdg-data");
    const ephemOpenCode = path.join(ephemXdg, "opencode");
    try {
      fs.mkdirSync(ephemOpenCode, { recursive: true });
      for (const name of ["auth.json", "mcp-auth.json"]) {
        linkOrCopyEntry(path.join(srcBase, name), path.join(ephemOpenCode, name));
      }
      env.XDG_DATA_HOME = ephemXdg;
    } catch {
      // ignore isolation failure and fall back cleanly
    }
    return;
  }

  if (agent === "antigravity") {
    const hasGeminiDir = args.some(
      (a) => a === "--gemini-dir" || a === "--gemini_dir" || a.startsWith("--gemini-dir=") || a.startsWith("--gemini_dir="),
    );
    if (hasGeminiDir) return;
    const candidates = [
      process.env.SNAP_USER_COMMON
        ? path.join(process.env.SNAP_USER_COMMON, ".gemini", "antigravity-cli")
        : "",
      path.join(home, "snap", "antigravity-cli", "common", ".gemini", "antigravity-cli"),
      path.join(home, ".gemini", "antigravity-cli"),
    ].filter(Boolean);
    const srcAppDir = candidates.find((c) => fs.existsSync(c));
    if (!srcAppDir) return;

    const ephemGemini = path.join(workdir, ".ephem-gemini");
    const ephemAppDir = path.join(ephemGemini, "antigravity-cli");
    try {
      fs.mkdirSync(ephemAppDir, { recursive: true });
      for (const entry of [
        "antigravity-oauth-token",
        "settings.json",
        "installation_id",
        "jetski_state.pbtxt",
        "builtin",
        "bin",
        "mcp",
      ]) {
        linkOrCopyEntry(path.join(srcAppDir, entry), path.join(ephemAppDir, entry));
      }
      args.push("--gemini-dir", ephemGemini);
    } catch {
      // ignore isolation failure and fall back cleanly
    }
  }
}
