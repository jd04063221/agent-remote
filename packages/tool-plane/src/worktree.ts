import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

export interface ChangedFileEntry {
  status: string;
  path: string;
}

/**
 * Manages isolated Git worktrees per concurrent agent thread, mirroring t3code's worktree workflow.
 */
export class WorktreeManager {
  readonly repoRoot: string;
  readonly worktreesDir: string;

  constructor(repoRoot: string, worktreesDir?: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.worktreesDir =
      worktreesDir ?? path.join(this.repoRoot, ".agent-remote", "worktrees");
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const out = await this.git(["worktree", "list", "--porcelain"]);
    const blocks = out.trim().split(/\n\n+/).filter(Boolean);
    const items: WorktreeInfo[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i]!.split("\n");
      let wtPath = "";
      let head = "";
      let branch = "detached";
      for (const line of lines) {
        if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
        else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch ")) {
          branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
        }
      }
      if (wtPath) {
        items.push({ path: wtPath, branch, head, isMain: i === 0 });
      }
    }
    return items;
  }

  async createWorktree(branchName: string, baseRef = "HEAD"): Promise<WorktreeInfo> {
    const safeName = branchName.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/\//g, "__");
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    const targetPath = path.join(this.worktreesDir, safeName);

    if (fs.existsSync(targetPath)) {
      const existing = (await this.listWorktrees()).find(
        (w) => path.resolve(w.path) === path.resolve(targetPath),
      );
      if (existing) return existing;
    }

    await this.git(["worktree", "add", "-b", branchName, targetPath, baseRef]);
    const head = (await this.git(["rev-parse", "HEAD"], targetPath)).trim();
    return { path: targetPath, branch: branchName, head, isMain: false };
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    await this.git(args);
  }

  async getStatus(cwd = this.repoRoot): Promise<ChangedFileEntry[]> {
    const out = await this.git(["status", "--porcelain=v1"], cwd);
    return out
      .split("\n")
      .filter((line) => line.length >= 4)
      .map((line) => ({
        status: line.slice(0, 2).trim() || "M",
        path: line.slice(3).trim(),
      }));
  }

  async getDiff(cwd = this.repoRoot, filePath?: string): Promise<string> {
    const args = ["diff", "HEAD"];
    if (filePath) args.push("--", filePath);
    try {
      return await this.git(args, cwd);
    } catch {
      // Fallback for unborn HEAD
      const fallback = ["diff"];
      if (filePath) fallback.push("--", filePath);
      return await this.git(fallback, cwd);
    }
  }

  async commitAll(message: string, cwd = this.repoRoot): Promise<string> {
    await this.git(["add", "-A"], cwd);
    await this.git(["commit", "-m", message], cwd);
    return (await this.git(["rev-parse", "--short", "HEAD"], cwd)).trim();
  }

  private async git(args: string[], cwd = this.repoRoot): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }
}
