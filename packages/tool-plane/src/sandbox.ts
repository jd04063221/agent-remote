import fs from "node:fs";
import path from "node:path";

export interface SandboxOptions {
  workspaceRoot: string;
  additionalDirs?: string[];
  readOnly?: boolean;
  /** When true (Full Access mode), allows reading/writing paths outside workspaceRoot. */
  allowOutsideWorkspace?: boolean;
}

const PROTECTED_GIT_PREFIXES = [".git/hooks", ".git/config", ".git/HEAD", ".git/refs"];

export class SandboxViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

/**
 * Enforces filesystem containment to a thread's assigned workspace / git worktree unless
 * `allowOutsideWorkspace` is explicitly enabled (Full Access mode).
 * Resolves symlinks on the nearest existing ancestor to prevent symlink traversal escapes.
 */
export class WorkspaceSandbox {
  readonly root: string;
  readonly allowedRoots: string[];
  readonly readOnly: boolean;
  private allowOutsideWorkspace: boolean;

  constructor(options: SandboxOptions) {
    this.root = fs.realpathSync(path.resolve(options.workspaceRoot));
    this.readOnly = Boolean(options.readOnly);
    this.allowOutsideWorkspace = Boolean(options.allowOutsideWorkspace);
    const extras = (options.additionalDirs ?? [])
      .map((d) => path.resolve(d))
      .filter((d) => fs.existsSync(d))
      .map((d) => fs.realpathSync(d));
    this.allowedRoots = [this.root, ...extras];
  }

  setAllowOutsideWorkspace(allow: boolean): void {
    this.allowOutsideWorkspace = allow;
  }

  isUnrestricted(): boolean {
    return this.allowOutsideWorkspace;
  }

  resolvePath(inputPath: string, mode: "read" | "write"): string {
    if (mode === "write" && this.readOnly) {
      throw new SandboxViolationError(
        `Write denied: sandbox is read-only for "${inputPath}".`,
      );
    }

    const candidate = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(this.root, inputPath);

    const realCandidate = resolveRealpathWithMissingTail(candidate);

    if (!this.allowOutsideWorkspace) {
      const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
      const normCandidate = norm(realCandidate);
      const insideAllowed = this.allowedRoots.some((allowed) => {
        const normAllowed = norm(allowed);
        const prefix = normAllowed.endsWith(path.sep) ? normAllowed : normAllowed + path.sep;
        return normCandidate === normAllowed || normCandidate.startsWith(prefix);
      });
      if (!insideAllowed) {
        throw new SandboxViolationError(
          `Path "${inputPath}" resolves to "${realCandidate}", which escapes workspace root "${this.root}".`,
        );
      }

      if (mode === "write") {
        const rel = path.relative(this.root, realCandidate).replaceAll(path.sep, "/");
        if (
          rel === ".git" ||
          PROTECTED_GIT_PREFIXES.some(
            (prefix) => rel === prefix || rel.startsWith(prefix + "/"),
          )
        ) {
          throw new SandboxViolationError(
            `Modifying protected git metadata "${rel}" is prohibited.`,
          );
        }
      }
    }

    return realCandidate;
  }

  toRelative(absPath: string): string {
    const rel = path.relative(this.root, absPath);
    if (rel === "") return ".";
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return absPath.replaceAll(path.sep, "/");
    }
    return rel.replaceAll(path.sep, "/");
  }
}

function resolveRealpathWithMissingTail(target: string): string {
  const missingSegments: string[] = [];
  let cursor = target;

  while (true) {
    if (fs.existsSync(cursor)) {
      const realBase = fs.realpathSync(cursor);
      return missingSegments.length > 0
        ? path.join(realBase, ...missingSegments.reverse())
        : realBase;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return target;
    }
    missingSegments.push(path.basename(cursor));
    cursor = parent;
  }
}
