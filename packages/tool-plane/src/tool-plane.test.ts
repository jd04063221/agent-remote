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

  it("supports workspace-full (sandboxed autonomous) and full-access (unrestricted) permission modes", () => {
    const wsPolicy = new PolicyEngine({
      mode: "workspace-full",
      rules: [
        { action: "command", pattern: "pnpm *", decision: "ask" },
        { action: "write", pattern: "*.secret", decision: "deny", reason: "secret protected" },
      ],
    });
    expect(wsPolicy.evaluate("write", "src/index.ts").decision).toBe("allow");
    expect(wsPolicy.evaluate("write", "prod.secret").decision).toBe("deny");
    expect(wsPolicy.evaluate("delete", "src/old.ts").decision).toBe("allow");
    expect(wsPolicy.evaluate("command", "pnpm test && go test ./...").decision).toBe("allow");
    expect(wsPolicy.evaluate("command", "python scripts/deploy.py").decision).toBe("allow");
    expect(wsPolicy.evaluate("mcp", "local_mcp__postgres__query").decision).toBe("allow");
    expect(wsPolicy.evaluate("command", "sudo apt update").decision).toBe("deny");
    expect(wsPolicy.evaluate("command", "rm -rf /").decision).toBe("deny");

    const fullPolicy = new PolicyEngine({ mode: "full-access" });
    expect(fullPolicy.evaluate("write", "/tmp/any-file.txt").decision).toBe("allow");
    expect(fullPolicy.evaluate("delete", "/tmp/any-file.txt").decision).toBe("allow");
    expect(fullPolicy.evaluate("command", "sudo systemctl restart demo").decision).toBe("allow");
    expect(fullPolicy.evaluate("mcp", "postgres_query").decision).toBe("allow");
    // Catastrophic accidental root wipe remains guarded even in full-access
    expect(fullPolicy.evaluate("command", "rm -rf /").decision).toBe("deny");
    expect(fullPolicy.evaluate("command", "mkfs.ext4 /dev/sda").decision).toBe("deny");

    // WorkspaceSandbox enforces containment by default and toggles cleanly for full-access
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-outside-test-"));
    const outsideFile = path.join(outsideDir, "note.txt");
    fs.writeFileSync(outsideFile, "outside");
    try {
      const sandbox = new WorkspaceSandbox({ workspaceRoot: tmpRoot });
      expect(() => sandbox.resolvePath(outsideFile, "read")).toThrow(SandboxViolationError);
      sandbox.setAllowOutsideWorkspace(true);
      expect(sandbox.resolvePath(outsideFile, "read")).toBe(fs.realpathSync(outsideFile));
      expect(sandbox.resolvePath(outsideFile, "write")).toBe(fs.realpathSync(outsideFile));
      sandbox.setAllowOutsideWorkspace(false);
      expect(() => sandbox.resolvePath(outsideFile, "read")).toThrow(SandboxViolationError);

      // Read-only subagent sandbox still blocks writes even when unrestricted for reads
      const roUnrestricted = new WorkspaceSandbox({
        workspaceRoot: tmpRoot,
        readOnly: true,
        allowOutsideWorkspace: true,
      });
      expect(roUnrestricted.resolvePath(outsideFile, "read")).toBe(fs.realpathSync(outsideFile));
      expect(() => roUnrestricted.resolvePath(outsideFile, "write")).toThrow(SandboxViolationError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
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

  it("resets run_command inactivity timer while script emits output and times out silent hangs", async () => {
    const sandbox = new WorkspaceSandbox({ workspaceRoot: tmpRoot });
    const policy = new PolicyEngine({ mode: "workspace-full" });
    const engine = new LocalToolEngine({ sandbox, policy });

    // Emits 3 ticks 500ms apart (1500ms total > 1000ms idle timeout) -> must succeed
    const activeRes = await engine.executeTool(
      "run_command",
      {
        command: `node -e "let n=0; const t=setInterval(()=>{ console.log('tick',++n); if(n===3){ clearInterval(t); } }, 450);"`,
        timeout_ms: 1000,
      },
      { sessionId: "s-active" },
    );
    expect(activeRes.ok).toBe(true);
    expect(activeRes.content).toContain("tick 3");

    // Silent hang -> must time out after 1000ms of inactivity
    const hangRes = await engine.executeTool(
      "run_command",
      {
        command: `node -e "setTimeout(()=>{}, 5000)"`,
        timeout_ms: 1000,
      },
      { sessionId: "s-hang" },
    );
    expect(hangRes.ok).toBe(false);
    expect(hangRes.content).toContain("inactivity");
  });
});
