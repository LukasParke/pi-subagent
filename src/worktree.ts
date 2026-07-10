import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (command: string, args: string[], cwd?: string, signal?: AbortSignal) => Promise<ExecResult>;

export interface WorktreeHandle {
  cwd: string;
  branch: string;
  baseCwd: string;
  baseCommit: string;
  changed: boolean;
  diffSummary?: string;
}

async function defaultExec(command: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Worktree command aborted"));
    const child = spawn(command, args, { cwd, signal, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Safe git-worktree isolation. Changed means uncommitted changes OR commits beyond base. */
export class WorktreeManager {
  constructor(private readonly execFn: ExecFn = defaultExec) {}

  async isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.execFn("git", ["rev-parse", "--is-inside-work-tree"], cwd, signal);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async create(baseCwd: string, label = "subagent", signal?: AbortSignal): Promise<WorktreeHandle> {
    if (!(await this.isGitRepo(baseCwd, signal))) throw new Error(`${baseCwd} is not a git repository`);
    const head = await this.execFn("git", ["rev-parse", "HEAD"], baseCwd, signal);
    if (head.code !== 0) throw new Error(`Unable to resolve HEAD: ${head.stderr.trim()}`);
    const baseCommit = head.stdout.trim();
    const id = randomUUID().slice(0, 8);
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 24) || "task";
    const branch = `pi-subagent/${safe}-${id}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wt-"));
    const cwd = path.join(root, "work");

    try {
      const result = await this.execFn("git", ["worktree", "add", "-b", branch, cwd, baseCommit], baseCwd, signal);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "git worktree add failed");
      return { cwd, branch, baseCwd, baseCommit, changed: false };
    } catch (error) {
      await this.execFn("git", ["worktree", "remove", "--force", cwd], baseCwd).catch(() => {});
      await this.execFn("git", ["branch", "-D", branch], baseCwd).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async refreshStatus(handle: WorktreeHandle, signal?: AbortSignal): Promise<WorktreeHandle> {
    const status = await this.execFn("git", ["status", "--porcelain"], handle.cwd, signal);
    if (status.code !== 0) throw new Error(`Unable to inspect worktree: ${status.stderr.trim()}`);
    const head = await this.execFn("git", ["rev-parse", "HEAD"], handle.cwd, signal);
    if (head.code !== 0) throw new Error(`Unable to inspect worktree HEAD: ${head.stderr.trim()}`);
    const hasCommits = head.stdout.trim() !== handle.baseCommit;
    const hasWorkingChanges = status.stdout.trim().length > 0;
    const changed = hasCommits || hasWorkingChanges;
    let diffSummary: string | undefined;
    if (changed) {
      const diff = await this.execFn("git", ["diff", "--stat", `${handle.baseCommit}..HEAD`], handle.cwd, signal);
      const working = await this.execFn("git", ["diff", "--stat"], handle.cwd, signal);
      diffSummary = [diff.stdout.trim(), working.stdout.trim(), status.stdout.trim()].filter(Boolean).join("\n");
    }
    return { ...handle, changed, diffSummary };
  }

  /** Preserve any branch with commits or uncommitted work; delete only truly unchanged worktrees. */
  async finalize(handle: WorktreeHandle, signal?: AbortSignal): Promise<WorktreeHandle> {
    const latest = await this.refreshStatus(handle, signal);
    if (latest.changed) return latest;
    const removed = await this.execFn("git", ["worktree", "remove", "--force", latest.cwd], latest.baseCwd);
    if (removed.code !== 0) throw new Error(`Unable to remove unchanged worktree: ${removed.stderr.trim()}`);
    await this.execFn("git", ["branch", "-D", latest.branch], latest.baseCwd).catch(() => {});
    await fs.rm(path.dirname(latest.cwd), { recursive: true, force: true });
    return latest;
  }

  async forceRemove(handle: WorktreeHandle): Promise<void> {
    await this.execFn("git", ["worktree", "remove", "--force", handle.cwd], handle.baseCwd).catch(() => {});
    await this.execFn("git", ["branch", "-D", handle.branch], handle.baseCwd).catch(() => {});
    await fs.rm(path.dirname(handle.cwd), { recursive: true, force: true });
  }
}
