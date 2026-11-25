export type PolicyAction = "read" | "search" | "write" | "delete" | "command" | "mcp";
export type PolicyDecision = "allow" | "ask" | "deny";
export const PERMISSION_MODES = [
  "plan",
  "default",
  "accept-edits",
  "auto",
  "workspace-full",
  "full-access",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PolicyRule {
  action: PolicyAction | "*";
  pattern: string;
  decision: PolicyDecision;
  reason?: string;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
  signature: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  action: PolicyAction;
  toolName: string;
  target: string;
  summary: string;
  diff?: string;
  command?: string;
  signature: string;
}

export type ApprovalOutcome =
  | { approved: true; scope: "once" | "session" }
  | { approved: false; reason?: string };

export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

// Always blocked in every mode to prevent catastrophic irreversible system destruction.
const CATASTROPHIC_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$|\*)/, reason: "destructive root deletion" },
  { re: /(^|[;&|]\s*)mkfs(\.[a-z0-9]+)?\s+/, reason: "filesystem formatting blocked" },
  { re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, reason: "fork bomb blocked" },
  { re: /(^|[;&|]\s*)(remove-item|ri|rd|rmdir)\b.*\s+([a-zA-Z]:\\(\s|$|\*)|\/(\s|$))/i, reason: "destructive Windows root deletion blocked" },
  { re: /(^|[;&|]\s*)format(\.com)?\s+[a-zA-Z]:/i, reason: "disk formatting blocked" },
];

// Blocked in workspace-scoped modes; permitted when the user explicitly selects `full-access`.
const PRIVILEGED_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)sudo\s+/, reason: "privileged sudo execution blocked by policy" },
  { re: /(curl|wget)\s+[^|]+\|\s*(ba)?sh(\s|$)/, reason: "piping remote script to shell blocked" },
  { re: /(irm|iwr|invoke-restmethod|invoke-webrequest)\s+[^|]+\|\s*(iex|invoke-expression)(\s|$)/i, reason: "piping remote script to PowerShell Invoke-Expression blocked" },
];

const SAFE_READONLY_COMMAND_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git branch",
  "ls",
  "pwd",
  "which",
  "node -v",
  "pnpm -v",
  "go version",
];

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private mode: PermissionMode;
  private readonly sessionAllowed = new Set<string>();

  constructor(options?: { mode?: PermissionMode; rules?: PolicyRule[] }) {
    this.mode = options?.mode ?? "default";
    this.rules = options?.rules ?? [];
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  allowForSession(signature: string): void {
    this.sessionAllowed.add(signature);
  }

  evaluate(action: PolicyAction, target: string): PolicyEvaluation {
    const signature = `${action}:${target}`;

    // 1. Hard-coded destructive command guard
    if (action === "command") {
      for (const guard of CATASTROPHIC_COMMAND_PATTERNS) {
        if (guard.re.test(target)) {
          return { decision: "deny", reason: guard.reason, signature };
        }
      }
      if (this.mode !== "full-access") {
        for (const guard of PRIVILEGED_COMMAND_PATTERNS) {
          if (guard.re.test(target)) {
            return { decision: "deny", reason: guard.reason, signature };
          }
        }
      }
    }

    // 2. Plan mode forbids all mutations and command executions
    if (this.mode === "plan" && (action === "write" || action === "delete" || action === "command")) {
      return {
        decision: "deny",
        reason: "Plan mode is read-only; mutations and shell commands are disabled.",
        signature,
      };
    }

    // 3. Explicit user rules with strict precedence: deny > ask > allow
    const matched = this.rules.filter(
      (r) => (r.action === "*" || r.action === action) && matchPattern(r.pattern, target),
    );
    const denyRule = matched.find((r) => r.decision === "deny");
    if (denyRule) {
      return { decision: "deny", reason: denyRule.reason ?? `Denied by rule ${denyRule.pattern}`, signature };
    }
    const askRule =
      this.mode === "workspace-full" || this.mode === "full-access"
        ? undefined
        : matched.find((r) => r.decision === "ask");
    if (askRule) {
      if (this.sessionAllowed.has(signature)) {
        return { decision: "allow", reason: "Approved earlier in this session", signature };
      }
      return { decision: "ask", reason: askRule.reason ?? `Requires approval by rule ${askRule.pattern}`, signature };
    }
    const allowRule = matched.find((r) => r.decision === "allow");
    if (allowRule) {
      return { decision: "allow", reason: allowRule.reason ?? `Allowed by rule ${allowRule.pattern}`, signature };
    }

    // 4. Session-scoped user approvals
    if (this.sessionAllowed.has(signature) || this.sessionAllowed.has(`${action}:*`)) {
      return { decision: "allow", reason: "Approved earlier in this session", signature };
    }

    // 5. Default mode matrix
    if (action === "read" || action === "search") {
      return { decision: "allow", reason: "Read-only inspection", signature };
    }
    if (
      action === "mcp" &&
      (target === "dispatch_subagent" || target === "call_remote_model")
    ) {
      return {
        decision: "allow",
        reason: "Subagent delegation (child tools enforce their own sandbox & policy)",
        signature,
      };
    }
    if (this.mode === "workspace-full" || this.mode === "full-access") {
      return {
        decision: "allow",
        reason: `Auto-allowed in ${this.mode} mode`,
        signature,
      };
    }
    if (action === "write") {
      if (this.mode === "accept-edits" || this.mode === "auto") {
        return { decision: "allow", reason: `Auto-allowed in ${this.mode} mode`, signature };
      }
      return { decision: "ask", reason: "File modification requires approval", signature };
    }
    if (action === "command") {
      if (
        this.mode === "auto" &&
        SAFE_READONLY_COMMAND_PREFIXES.some(
          (p) => target.trim() === p || target.trim().startsWith(p + " "),
        )
      ) {
        return { decision: "allow", reason: "Safe inspection command in auto mode", signature };
      }
      return { decision: "ask", reason: "Shell execution requires approval", signature };
    }

    return { decision: "ask", reason: `Action "${action}" requires approval`, signature };
  }
}

function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  if (pattern.startsWith("regex:")) {
    try {
      return new RegExp(pattern.slice("regex:".length)).test(value);
    } catch {
      return false;
    }
  }
  // Simple glob conversion (* -> [^/]*, ** -> .*)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
