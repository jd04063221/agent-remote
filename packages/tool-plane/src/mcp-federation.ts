import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LocalToolEngine, ToolDefinition } from "./tools.js";

export interface LocalMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface JsonRpcRes {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Connects to a user-configured local stdio MCP server (e.g. local Postgres, intranet GitLab, Playwright)
 * and federates its tools into LocalToolEngine under `local_mcp__<server>__<tool>` gated by PolicyEngine.
 */
export class StdioMcpClient {
  readonly name: string;
  private readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(cfg: LocalMcpServerConfig) {
    this.name = cfg.name;
    // On Windows, `npx` / npm-installed shims are `.cmd` scripts and require shell resolution unless an explicit .exe is given.
    const needsWinShell =
      process.platform === "win32" && !cfg.command.toLowerCase().endsWith(".exe");
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      shell: needsWinShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.on("exit", () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Local MCP server "${this.name}" exited`));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "agent-remote-federation", version: "0.1.0" },
    });
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }

  async listTools(): Promise<ToolDefinition[]> {
    const res = await this.request("tools/list", {});
    const tools = (res.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const res = await this.request("tools/call", { name, arguments: args }, 600_000);
    const items = (res.content ?? []) as Array<{ text?: string }>;
    const text = items.map((i) => i.text ?? "").join("\n");
    return { ok: !res.isError, content: text };
  }

  close(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Local MCP server "${this.name}" closed`));
    }
    this.pending.clear();
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

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local MCP "${this.name}" RPC "${method}" timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcRes;
      try {
        msg = JSON.parse(line) as JsonRpcRes;
      } catch {
        continue;
      }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result ?? {});
      }
    }
  }
}

/**
 * Mounts one or more local stdio MCP servers into a LocalToolEngine so remote agents
 * can invoke local intranet/database/OAuth MCP tools securely through the local Policy Gate.
 */
export async function mountLocalMcpServers(
  engine: LocalToolEngine,
  configs: LocalMcpServerConfig[],
): Promise<StdioMcpClient[]> {
  const clients: StdioMcpClient[] = [];
  for (const cfg of configs) {
    const client = new StdioMcpClient(cfg);
    await client.initialize();
    const tools = await client.listTools();
    for (const tool of tools) {
      const namespaced = `local_mcp__${cfg.name}__${tool.name}`;
      engine.registerCustomTool({
        action: "mcp",
        definition: {
          name: namespaced,
          description: `[Local MCP: ${cfg.name}] ${tool.description}`,
          inputSchema: tool.inputSchema,
        },
        execute: async (args) => client.callTool(tool.name, args),
      });
    }
    clients.push(client);
  }
  return clients;
}
