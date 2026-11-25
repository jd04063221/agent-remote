import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalToolEngine,
  mountLocalMcpServers,
  PolicyEngine,
  WorkspaceSandbox,
} from "./index.js";

describe("Local MCP Federation", () => {
  it("discovers and executes tools from a local stdio MCP server through PolicyEngine", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-mcpfed-"));
    const mockServerScript = path.join(tmp, "mock-mcp.mjs");
    fs.writeFileSync(
      mockServerScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping_db", description: "Ping local DB", inputSchema: { type: "object" } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong:" + (msg.params?.arguments?.key ?? "") }] } }) + "\\n");
  }
});
`,
    );

    const engine = new LocalToolEngine({
      sandbox: new WorkspaceSandbox({ workspaceRoot: tmp }),
      policy: new PolicyEngine({
        rules: [{ action: "mcp", pattern: "*", decision: "allow" }],
      }),
    });

    const clients = await mountLocalMcpServers(engine, [
      { name: "pg_dev", command: process.execPath, args: [mockServerScript] },
    ]);

    try {
      const names = engine.listToolDefinitions().map((t) => t.name);
      expect(names).toContain("local_mcp__pg_dev__ping_db");

      const res = await engine.executeTool(
        "local_mcp__pg_dev__ping_db",
        { key: "ok" },
        { sessionId: "s1" },
      );
      expect(res.ok).toBe(true);
      expect(res.content).toBe("pong:ok");
    } finally {
      for (const c of clients) c.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
