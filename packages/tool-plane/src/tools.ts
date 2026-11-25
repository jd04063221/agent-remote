import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let cachedWinShell: string | undefined;

const POWERSHELL_UTF8_PREAMBLE =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ";

/**
 * Resolves the local shell binary and arguments for `run_command`:
 * - On Windows (`win32`): uses PowerShell (`pwsh` if available, else `powershell.exe`) with `-NoProfile -NonInteractive -Command`
 *   and forces UTF-8 stdout encoding so Chinese/Unicode output never corrupts under Windows CP936/OEM codepages.
 * - On Linux/macOS: uses `bash -lc`.
 */
export function resolveLocalShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  hasBinary?: (name: string) => boolean,
): { bin: string; args: string[] } {
  const override = env.AGENT_REMOTE_SHELL?.trim();
  if (override) {
    const lower = path.basename(override).toLowerCase();
    if (lower.includes("pwsh") || lower.includes("powershell")) {
      return {
        bin: override,
        args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8_PREAMBLE + command],
      };
    }
    if (lower === "cmd" || lower === "cmd.exe") {
      return { bin: override, args: ["/d", "/s", "/c", command] };
    }
    return { bin: override, args: ["-lc", command] };
  }

  if (platform === "win32") {
    const check =
      hasBinary ??
      ((name: string) => {
        try {
          execFileSync("where", [name], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      });
    const shellBin =
      hasBinary !== undefined
        ? check("pwsh")
          ? "pwsh"
          : "powershell.exe"
        : (cachedWinShell ??= check("pwsh") ? "pwsh" : "powershell.exe");
    return {
      bin: shellBin,
      args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8_PREAMBLE + command],
    };
  }

  return { bin: "bash", args: ["-lc", command] };
}

import { createUnifiedDiff } from "./diff.js";
import {
  type ApprovalCallback,
  type PolicyAction,
  PolicyEngine,
} from "./policy.js";
import { WorkspaceSandbox } from "./sandbox.js";

function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const pick =
    args.path ??
    args.command ??
    args.pattern ??
    args.subagent ??
    args.query ??
    "";
  const raw = typeof pick === "string" ? pick.trim() : "";
  if (!raw) return toolName;
  const compact = raw.replace(/\s+/g, " ");
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".pnpm-store",
  ".agent-remote",
]);

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutionContext {
  sessionId: string;
  signal?: AbortSignal;
  onTerminalOutput?: (chunk: string) => void;
}

export interface ToolCallResult {
  ok: boolean;
  content: string;
  diff?: string;
  metadata?: Record<string, unknown>;
}

export interface CustomToolHandler {
  definition: ToolDefinition;
  action: PolicyAction;
  execute: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<ToolCallResult>;
}

export interface ToolProgressEvent {
  phase: "start" | "end";
  toolName: string;
  summary: string;
  ok?: boolean;
}

export interface LocalToolEngineOptions {
  sandbox: WorkspaceSandbox;
  policy: PolicyEngine;
  onApprovalNeeded?: ApprovalCallback;
  onToolEvent?: (ev: ToolProgressEvent) => void;
}

export class LocalToolEngine {
  readonly sandbox: WorkspaceSandbox;
  readonly policy: PolicyEngine;
  private readonly onApprovalNeeded?: ApprovalCallback;
  private readonly onToolEvent?: (ev: ToolProgressEvent) => void;
  private readonly customTools = new Map<string, CustomToolHandler>();

  constructor(options: LocalToolEngineOptions) {
    this.sandbox = options.sandbox;
    this.policy = options.policy;
    this.onApprovalNeeded = options.onApprovalNeeded;
    this.onToolEvent = options.onToolEvent;
  }

  registerCustomTool(handler: CustomToolHandler): void {
    this.customTools.set(handler.definition.name, handler);
  }

  listToolDefinitions(): ToolDefinition[] {
    const builtins: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a UTF-8 text file inside the local workspace/worktree with optional 1-based line slicing.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative or workspace-absolute file path" },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Create or overwrite a file inside the local workspace/worktree.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace an exact text target inside an existing local file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            target: { type: "string" },
            replacement: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "target", "replacement"],
        },
      },
      {
        name: "delete_file",
        description: "Delete a file inside the local workspace/worktree.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
      {
        name: "list_dir",
        description: "List files and directories inside a local workspace directory.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", default: "." },
            max_entries: { type: "integer", default: 200 },
          },
        },
      },
      {
        name: "glob",
        description: "Find files matching a glob pattern inside the local workspace.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            max_results: { type: "integer", default: 200 },
          },
          required: ["pattern"],
        },
      },
      {
        name: "grep",
        description: "Search file contents inside the local workspace using a regex pattern.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string", default: "." },
            max_matches: { type: "integer", default: 100 },
          },
          required: ["pattern"],
        },
      },
      {
        name: "run_command",
        description: "Execute a shell command in the local workspace/worktree.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeout_ms: { type: "integer", default: 120000 },
          },
          required: ["command"],
        },
      },
    ];

    const custom = Array.from(this.customTools.values()).map((h) => h.definition);
    return [...builtins, ...custom];
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (ctx.signal?.aborted) {
      return { ok: false, content: "Cancelled by user." };
    }

    const summary = summarizeToolArgs(toolName, args);
    this.onToolEvent?.({ phase: "start", toolName, summary });
    let result: ToolCallResult = { ok: false, content: "Tool failed" };
    try {
      const custom = this.customTools.get(toolName);
      if (custom) {
        const gate = await this.enforcePolicy(
          ctx.sessionId,
          custom.action,
          toolName,
          toolName,
          `Invoke tool ${toolName}`,
        );
        if (gate) {
          result = gate;
          return result;
        }
        result = await custom.execute(args, ctx);
        return result;
      }

      switch (toolName) {
        case "read_file":
          result = await this.readFile(args, ctx);
          return result;
        case "write_file":
          result = await this.writeFile(args, ctx);
          return result;
        case "edit_file":
          result = await this.editFile(args, ctx);
          return result;
        case "delete_file":
          result = await this.deleteFile(args, ctx);
          return result;
        case "list_dir":
          result = await this.listDir(args, ctx);
          return result;
        case "glob":
          result = await this.globFiles(args, ctx);
          return result;
        case "grep":
          result = await this.grepFiles(args, ctx);
          return result;
        case "run_command":
          result = await this.runCommand(args, ctx);
          return result;
        default:
          result = { ok: false, content: `Unknown local tool "${toolName}".` };
          return result;
      }
    } finally {
      this.onToolEvent?.({ phase: "end", toolName, summary, ok: result.ok });
    }
  }

  private async enforcePolicy(
    sessionId: string,
    action: PolicyAction,
    toolName: string,
    target: string,
    summary: string,
    extra?: { diff?: string; command?: string },
  ): Promise<ToolCallResult | null> {
    const evalRes = this.policy.evaluate(action, target);
    if (evalRes.decision === "allow") return null;
    if (evalRes.decision === "deny") {
      return { ok: false, content: `Policy denied (${evalRes.reason}).` };
    }
    if (!this.onApprovalNeeded) {
      return {
        ok: false,
        content: `Approval required for ${summary} (${evalRes.reason}), but no approval handler is attached.`,
      };
    }

    const outcome = await this.onApprovalNeeded({
      id: crypto.randomUUID(),
      sessionId,
      action,
      toolName,
      target,
      summary,
      diff: extra?.diff,
      command: extra?.command,
      signature: evalRes.signature,
    });
    if (!outcome.approved) {
      return {
        ok: false,
        content: outcome.reason
          ? `User rejected action: ${outcome.reason}`
          : "User rejected action.",
      };
    }
    if (outcome.scope === "session") {
      this.policy.allowForSession(evalRes.signature);
    }
    return null;
  }

  private async readFile(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const rawPath = String(args.path ?? "");
    const abs = this.sandbox.resolvePath(rawPath, "read");
    const rel = this.sandbox.toRelative(abs);

    const gate = await this.enforcePolicy(ctx.sessionId, "read", "read_file", rel, `Read ${rel}`);
    if (gate) return gate;

    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return { ok: false, content: `File not found or is a directory: ${rel}` };
    }

    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) {
      return {
        ok: false,
        content: `Binary file detected (${rel}, ${buf.byteLength} bytes); refusing text read.`,
      };
    }

    const lines = buf.toString("utf8").split(/\r?\n/);
    const start = Math.max(1, Number(args.start_line ?? 1));
    const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
    const sliced = lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}: ${line}`)
      .join("\n");

    const truncated = truncateUtf8(sliced, MAX_OUTPUT_BYTES);
    return {
      ok: true,
      content: `File: ${rel} (lines ${start}-${end} of ${lines.length})\n${truncated.text}${
        truncated.wasTruncated ? "\n...[truncated at 64KB; request a narrower line range]" : ""
      }`,
    };
  }

  private async writeFile(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const rawPath = String(args.path ?? "");
    const content = String(args.content ?? "");
    const abs = this.sandbox.resolvePath(rawPath, "write");
    const rel = this.sandbox.toRelative(abs);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const diff = createUnifiedDiff(rel, before, content);

    const gate = await this.enforcePolicy(
      ctx.sessionId,
      "write",
      "write_file",
      rel,
      `Write ${rel}`,
      { diff },
    );
    if (gate) return gate;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { ok: true, content: `Wrote ${rel} (${Buffer.byteLength(content)} bytes).`, diff };
  }

  private async editFile(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const rawPath = String(args.path ?? "");
    const target = String(args.target ?? "");
    const replacement = String(args.replacement ?? "");
    const replaceAll = Boolean(args.replace_all);

    const abs = this.sandbox.resolvePath(rawPath, "write");
    const rel = this.sandbox.toRelative(abs);
    if (!fs.existsSync(abs)) {
      return { ok: false, content: `File not found: ${rel}` };
    }

    const before = fs.readFileSync(abs, "utf8");
    if (!target || !before.includes(target)) {
      return { ok: false, content: `Target snippet not found in ${rel}.` };
    }

    const occurrences = before.split(target).length - 1;
    if (!replaceAll && occurrences > 1) {
      return {
        ok: false,
        content: `Target snippet matched ${occurrences} times in ${rel}; provide more context or set replace_all=true.`,
      };
    }

    const after = replaceAll
      ? before.split(target).join(replacement)
      : before.replace(target, replacement);
    const diff = createUnifiedDiff(rel, before, after);

    const gate = await this.enforcePolicy(
      ctx.sessionId,
      "write",
      "edit_file",
      rel,
      `Edit ${rel}`,
      { diff },
    );
    if (gate) return gate;

    fs.writeFileSync(abs, after, "utf8");
    return { ok: true, content: `Edited ${rel} (${occurrences} replacement(s)).`, diff };
  }

  private async deleteFile(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const rawPath = String(args.path ?? "");
    const abs = this.sandbox.resolvePath(rawPath, "write");
    const rel = this.sandbox.toRelative(abs);

    const gate = await this.enforcePolicy(
      ctx.sessionId,
      "delete",
      "delete_file",
      rel,
      `Delete ${rel}`,
    );
    if (gate) return gate;

    if (!fs.existsSync(abs)) {
      return { ok: false, content: `File not found: ${rel}` };
    }
    fs.unlinkSync(abs);
    return { ok: true, content: `Deleted ${rel}.` };
  }

  private async listDir(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const rawPath = String(args.path ?? ".");
    const maxEntries = Math.max(1, Math.min(1000, Number(args.max_entries ?? 200)));
    const abs = this.sandbox.resolvePath(rawPath, "read");
    const rel = this.sandbox.toRelative(abs);

    const gate = await this.enforcePolicy(ctx.sessionId, "search", "list_dir", rel, `List ${rel}`);
    if (gate) return gate;

    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return { ok: false, content: `Not a directory: ${rel}` };
    }

    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => !DEFAULT_IGNORED_DIRS.has(e.name))
      .slice(0, maxEntries)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

    return { ok: true, content: entries.join("\n") || "(empty directory)" };
  }

  private async globFiles(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const pattern = String(args.pattern ?? "**/*").replaceAll("\\", "/");
    const maxResults = Math.max(1, Math.min(1000, Number(args.max_results ?? 200)));

    const gate = await this.enforcePolicy(ctx.sessionId, "search", "glob", pattern, `Glob ${pattern}`);
    if (gate) return gate;

    const regex = globToRegExp(pattern);
    const matches: string[] = [];
    walkFiles(this.sandbox.root, this.sandbox.root, (rel) => {
      if (matches.length >= maxResults) return false;
      if (regex.test(rel)) matches.push(rel);
      return true;
    });

    return { ok: true, content: matches.join("\n") || "(no matches)" };
  }

  private async grepFiles(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const pattern = String(args.pattern ?? "");
    const rawPath = String(args.path ?? ".");
    const maxMatches = Math.max(1, Math.min(500, Number(args.max_matches ?? 100)));
    const abs = this.sandbox.resolvePath(rawPath, "read");
    const relRoot = this.sandbox.toRelative(abs);

    const gate = await this.enforcePolicy(
      ctx.sessionId,
      "search",
      "grep",
      relRoot,
      `Grep "${pattern}" in ${relRoot}`,
    );
    if (gate) return gate;

    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return { ok: false, content: `Invalid regex "${pattern}": ${(err as Error).message}` };
    }

    const hits: string[] = [];
    const scanFile = (fileAbs: string) => {
      if (hits.length >= maxMatches) return;
      const stat = fs.statSync(fileAbs);
      if (stat.size > 1024 * 1024) return;
      const buf = fs.readFileSync(fileAbs);
      if (buf.subarray(0, 4096).includes(0)) return;
      const rel = this.sandbox.toRelative(fileAbs);
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
        }
      }
    };

    if (fs.statSync(abs).isFile()) {
      scanFile(abs);
    } else {
      walkFiles(abs, this.sandbox.root, (_rel, fullAbs) => {
        scanFile(fullAbs);
        return hits.length < maxMatches;
      });
    }

    return { ok: true, content: hits.join("\n") || "(no matches)" };
  }

  private async runCommand(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, content: "Command must not be empty." };

    const cwd = args.cwd
      ? this.sandbox.resolvePath(String(args.cwd), "read")
      : this.sandbox.root;
    const timeoutMs = Math.max(1000, Math.min(600_000, Number(args.timeout_ms ?? 120_000)));

    const gate = await this.enforcePolicy(
      ctx.sessionId,
      "command",
      "run_command",
      command,
      `Run command: ${command}`,
      { command },
    );
    if (gate) return gate;

    return await new Promise<ToolCallResult>((resolve) => {
      const shell = resolveLocalShell(command);
      const child = spawn(shell.bin, shell.args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let truncated = false;
      let killedReason: string | undefined;

      const append = (buf: Buffer) => {
        const text = buf.toString("utf8");
        ctx.onTerminalOutput?.(text);
        if (Buffer.byteLength(output) + Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        output += text;
      };

      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const killGroup = (reason: string) => {
        killedReason = reason;
        if (child.pid) {
          try {
            if (process.platform !== "win32") {
              process.kill(-child.pid, "SIGTERM");
            } else {
              // On Windows, terminate the entire spawned PowerShell/subcommand process tree cleanly
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
              });
            }
          } catch {
            // already exited
          }
          setTimeout(() => {
            if (child.pid && child.exitCode === null) {
              try {
                if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
                else child.kill("SIGKILL");
              } catch {
                // already exited
              }
            }
          }, 1500).unref();
        }
      };

      const timer = setTimeout(() => killGroup(`Timed out after ${timeoutMs}ms`), timeoutMs);
      const onAbort = () => killGroup("Cancelled by user");
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ ok: false, content: `Failed to spawn command: ${err.message}` });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const suffix = truncated ? "\n...[output truncated at 64KB]" : "";
        if (killedReason) {
          resolve({
            ok: false,
            content: `${killedReason}\n${output}${suffix}`,
            metadata: { exitCode: code ?? -1 },
          });
          return;
        }
        resolve({
          ok: code === 0,
          content: `Exit code: ${code ?? -1}\n${output}${suffix}`,
          metadata: { exitCode: code ?? -1 },
        });
      });
    });
  }
}

function walkFiles(
  dir: string,
  root: string,
  visit: (rel: string, fullAbs: string) => boolean,
): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (DEFAULT_IGNORED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!walkFiles(full, root, visit)) return false;
    } else if (e.isFile()) {
      const rel = path.relative(root, full).replaceAll(path.sep, "/");
      if (!visit(rel, full)) return false;
    }
  }
  return true;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "__DOUBLE_STAR_SLASH__")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLE_STAR_SLASH__/g, "(?:.*/)?")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; wasTruncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, wasTruncated: false };
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    wasTruncated: true,
  };
}
