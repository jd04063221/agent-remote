import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalToolEngine,
  McpJsonRpcHandler,
  PolicyEngine,
  SandboxViolationError,
  WorkspaceSandbox,
} from "./index.js";

describe("@agent-remote/tool-plane", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-tp-test-"));
    fs.writeFileSync(path.join(tmpRoot, "hello.ts"), "export const x = 1;\nexport const y = 2;\n");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("blocks path traversal and protected .git/hooks writes", () => {
    const sandbox = new WorkspaceSandbox({ workspaceRoot: tmpRoot });
    expect(() => sandbox.resolvePath("../../etc/passwd", "read")).toThrow(SandboxViolationError);
    expect(() => sandbox.resolvePath(".git/hooks/pre-commit", "write")).toThrow(
      SandboxViolationError,
    );
    expect(sandbox.resolvePath("hello.ts", "read")).toBe(path.join(fs.realpathSync(tmpRoot), "hello.ts"));
  });

  it("enforces PolicyEngine deny > ask > allow and destructive command blocks", () => {
    const policy = new PolicyEngine({
      mode: "auto",
      rules: [
        { action: "write", pattern: "*.secret", decision: "deny", reason: "no secret edits" },
        { action: "write", pattern: "**", decision: "allow" },
      ],
    });

    expect(policy.evaluate("write", "foo.secret").decision).toBe("deny");
    expect(policy.evaluate("write", "src/app.ts").decision).toBe("allow");
    expect(policy.evaluate("command", "rm -rf /").decision).toBe("deny");
    expect(policy.evaluate("command", "sudo apt update").decision).toBe("deny");
    expect(policy.evaluate("command", "git status").decision).toBe("allow");
  });

  it("executes read/edit/grep/command and MCP JSON-RPC calls with approval gating", async () => {
    const sandbox = new WorkspaceSandbox({ workspaceRoot: tmpRoot });
    const policy = new PolicyEngine({ mode: "default" });
    const approvals: string[] = [];

    const engine = new LocalToolEngine({
      sandbox,
      policy,
      onApprovalNeeded: async (req) => {
        approvals.push(req.toolName);
        return { approved: true, scope: "once" };
      },
    });

    const mcp = new McpJsonRpcHandler(engine);

    // 1. tools/list over MCP JSON-RPC
    const listRes = await mcp.handleRpc(
      {
        rpcId: "r1",
        sessionId: "s1",
        method: "POST",
        path: "/mcp",
        headers: {},
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      { sessionId: "s1" },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body).toContain("read_file");
    expect(listRes.body).toContain("run_command");

    // 2. edit_file triggers approval and produces unified diff
    const editRes = await engine.executeTool(
      "edit_file",
      { path: "hello.ts", target: "x = 1", replacement: "x = 42" },
      { sessionId: "s1" },
    );
    expect(editRes.ok).toBe(true);
    expect(editRes.diff).toContain("-export const x = 1;");
    expect(editRes.diff).toContain("+export const x = 42;");
    expect(approvals).toContain("edit_file");

    // 3. grep finds updated value
    const grepRes = await engine.executeTool(
      "grep",
      { pattern: "x = 42" },
      { sessionId: "s1" },
    );
    expect(grepRes.ok).toBe(true);
    expect(grepRes.content).toContain("hello.ts:1:");

    // 4. run_command executes inside workspace
    const cmdRes = await engine.executeTool(
      "run_command",
      { command: "echo hi-from-local" },
      { sessionId: "s1" },
    );
    expect(cmdRes.ok).toBe(true);
    expect(cmdRes.content).toContain("hi-from-local");
  });
});
