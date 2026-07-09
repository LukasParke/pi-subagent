import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, args: string[], cwd?: string) => Promise<ExecResult>;

export interface WorktreeHandle {
  cwd: string;
  branch: string;
  baseCwd: string;
  changed: boolean;
  diffSummary?: string;
}

async function defaultExec(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Creates temporary git worktrees for isolated write-capable parallel workers.
 * Never shell-interpolates arguments.
 */
export class WorktreeManager {
  private readonly execFn: ExecFn;
  private readonly handles = new Map<string, WorktreeHandle>();

  constructor(execFn: ExecFn = defaultExec) {
    this.execFn = execFn;
  }

  /** Returns true when `cwd` is inside a git work tree. */
  async isGitRepo(cwd: string): Promise<boolean> {
    const res = await this.execFn("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  /**
   * Create a unique worktree checked out from the current HEAD.
   * Throws if base is not a git repo.
   */
  async create(baseCwd: string, label = "subagent"): Promise<WorktreeHandle> {
    if (!(await this.isGitRepo(baseCwd))) {
      throw new Error(`Cannot create worktree: ${baseCwd} is not a git repository`);
    }

    const head = await this.execFn("git", ["rev-parse", "HEAD"], baseCwd);
    if (head.code !== 0) {
      throw new Error(`Unable to resolve HEAD in ${baseCwd}: ${head.stderr.trim()}`);
    }

    const id = randomUUID().slice(0, 8);
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 24) || "task";
    const branch = `pi-subagent/${safeLabel}-${id}`;
    const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wt-"));
    const cwd = path.join(worktreeRoot, "work");

    const branchRes = await this.execFn("git", ["branch", branch, "HEAD"], baseCwd);
    if (branchRes.code !== 0) {
      throw new Error(`Failed to create branch ${branch}: ${branchRes.stderr.trim()}`);
    }

    const wt = await this.execFn("git", ["worktree", "add", cwd, branch], baseCwd);
    if (wt.code !== 0) {
      await this.execFn("git", ["branch", "-D", branch], baseCwd).catch(() => {});
      throw new Error(`Failed to create worktree: ${wt.stderr.trim()}`);
    }

    const handle: WorktreeHandle = {
      cwd,
      branch,
      baseCwd,
      changed: false,
    };
    this.handles.set(cwd, handle);
    return handle;
  }

  /** Detect whether the worktree has uncommitted changes relative to its branch base. */
  async refreshStatus(handle: WorktreeHandle): Promise<WorktreeHandle> {
    const status = await this.execFn("git", ["status", "--porcelain"], handle.cwd);
    const changed = status.code === 0 && status.stdout.trim().length > 0;
    let diffSummary: string | undefined;
    if (changed) {
      const diff = await this.execFn("git", ["diff", "--stat"], handle.cwd);
      diffSummary = diff.stdout.trim() || status.stdout.trim();
    }
    const next = { ...handle, changed, diffSummary };
    this.handles.set(handle.cwd, next);
    return next;
  }

  /**
   * Cleanup an unchanged worktree automatically.
   * Changed worktrees are preserved and returned with metadata (no auto-merge).
   */
  async finalize(handle: WorktreeHandle): Promise<WorktreeHandle> {
    const latest = await this.refreshStatus(handle);
    if (latest.changed) {
      return latest;
    }

    await this.execFn("git", ["worktree", "remove", "--force", latest.cwd], latest.baseCwd);
    await this.execFn("git", ["branch", "-D", latest.branch], latest.baseCwd).catch(() => {});
    try {
      await fs.rm(path.dirname(latest.cwd), { recursive: true, force: true });
    } catch {
      // best effort
    }
    this.handles.delete(latest.cwd);
    return { ...latest, changed: false };
  }

  /** Force-remove a worktree even if changed. */
  async forceRemove(handle: WorktreeHandle): Promise<void> {
    await this.execFn("git", ["worktree", "remove", "--force", handle.cwd], handle.baseCwd).catch(() => {});
    await this.execFn("git", ["branch", "-D", handle.branch], handle.baseCwd).catch(() => {});
    try {
      await fs.rm(path.dirname(handle.cwd), { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.handles.delete(handle.cwd);
  }
}
