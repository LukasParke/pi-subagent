import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig } from "./config.js";

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

export interface SweepReport {
  pruned: boolean;
  removed: string[];
  kept: string[];
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

/**
 * Safe git-worktree isolation. Changed means uncommitted changes OR commits beyond base.
 *
 * Worktrees live under a durable root (default ~/.pi/subagent-worktrees/<repo-hash>/),
 * never a purgeable OS tmpdir, so preserved work survives reboots. `sweep()` garbage
 * collects unchanged or expired leftovers from crashes and failed finalizations.
 */
export class WorktreeManager {
  constructor(
    private readonly execFn: ExecFn = defaultExec,
    private readonly rootDir: string = defaultConfig.worktreeDir,
  ) {}

  async isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.execFn("git", ["rev-parse", "--is-inside-work-tree"], cwd, signal);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  /** Stable per-repo container so sweep can enumerate all worktrees for one repo. */
  repoRoot(baseCwd: string): string {
    const hash = createHash("sha256").update(path.resolve(baseCwd)).digest("hex").slice(0, 12);
    const name = path.basename(path.resolve(baseCwd)).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "repo";
    return path.join(this.rootDir, `${name}-${hash}`);
  }

  async create(baseCwd: string, label = "subagent", signal?: AbortSignal): Promise<WorktreeHandle> {
    if (!(await this.isGitRepo(baseCwd, signal))) throw new Error(`${baseCwd} is not a git repository`);
    const head = await this.execFn("git", ["rev-parse", "HEAD"], baseCwd, signal);
    if (head.code !== 0) throw new Error(`Unable to resolve HEAD: ${head.stderr.trim()}`);
    const baseCommit = head.stdout.trim();
    const id = randomUUID().slice(0, 8);
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 24) || "task";
    const branch = `pi-subagent/${safe}-${id}`;
    const root = path.join(this.repoRoot(baseCwd), `${safe}-${id}`);
    await fs.mkdir(root, { recursive: true });
    const cwd = path.join(root, "work");

    try {
      const result = await this.execFn("git", ["worktree", "add", "-b", branch, cwd, baseCommit], baseCwd, signal);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "git worktree add failed");
      // Marker lets sweep() find the owning repo for orphaned directories.
      await fs.writeFile(path.join(root, "base-repo"), `${path.resolve(baseCwd)}\n`, "utf8").catch(() => {});
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

  /** Make untracked files visible to `git diff` (intent-to-add). Safe on finished worktrees. */
  private async stageUntracked(cwd: string, signal?: AbortSignal): Promise<void> {
    await this.execFn("git", ["add", "-A", "--intent-to-add"], cwd, signal).catch(() => {});
  }

  /** Full patch (committed beyond base + uncommitted + untracked) of a worktree, capped. */
  async diff(
    worktree: { cwd: string; baseCommit: string },
    maxBytes = 256 * 1024,
    signal?: AbortSignal,
  ): Promise<{ stat: string; patch: string; truncated: boolean }> {
    await this.stageUntracked(worktree.cwd, signal);
    const stat = await this.execFn("git", ["diff", "--stat", worktree.baseCommit], worktree.cwd, signal);
    if (stat.code !== 0) throw new Error(`Unable to diff worktree: ${stat.stderr.trim()}`);
    const patch = await this.execFn("git", ["diff", worktree.baseCommit], worktree.cwd, signal);
    if (patch.code !== 0) throw new Error(`Unable to diff worktree: ${patch.stderr.trim()}`);
    const full = patch.stdout;
    const truncated = Buffer.byteLength(full, "utf8") > maxBytes;
    return {
      stat: stat.stdout.trim(),
      patch: truncated ? full.slice(0, maxBytes) : full,
      truncated,
    };
  }

  /**
   * Apply a worktree's changes (committed + uncommitted vs base) onto the base
   * checkout as working-tree changes via `git apply --3way`. Never commits and
   * never deletes the worktree — review/discard stays a separate explicit step.
   */
  async apply(
    worktree: { cwd: string; baseCommit: string; branch?: string },
    baseCwd: string,
    signal?: AbortSignal,
  ): Promise<{ applied: boolean; stat: string }> {
    if (!(await this.isGitRepo(baseCwd, signal))) throw new Error(`${baseCwd} is not a git repository`);
    const status = await this.execFn("git", ["status", "--porcelain"], worktree.cwd, signal);
    if (status.code !== 0) throw new Error(`Unable to inspect worktree: ${status.stderr.trim()}`);
    await this.stageUntracked(worktree.cwd, signal);
    const diff = await this.execFn("git", ["diff", "--binary", worktree.baseCommit], worktree.cwd, signal);
    if (diff.code !== 0) throw new Error(`Unable to diff worktree: ${diff.stderr.trim()}`);
    if (!diff.stdout.trim()) return { applied: false, stat: "(no changes to apply)" };

    // --3way merges via blob identity (same object store) and surfaces conflicts
    // as markers instead of failing outright on drifted context.
    const result = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("git", ["apply", "--3way", "--whitespace=nowarn"], {
        cwd: baseCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin?.on("error", () => { /* EPIPE when git exits early */ });
      child.stdin?.end(diff.stdout);
    });
    if (result.code !== 0) {
      throw new Error(`git apply failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
    }
    const stat = await this.execFn("git", ["diff", "--stat"], baseCwd, signal);
    return { applied: true, stat: stat.stdout.trim() || "(applied)" };
  }

  async forceRemove(handle: WorktreeHandle): Promise<void> {
    await this.execFn("git", ["worktree", "remove", "--force", handle.cwd], handle.baseCwd).catch(() => {});
    await this.execFn("git", ["branch", "-D", handle.branch], handle.baseCwd).catch(() => {});
    await fs.rm(path.dirname(handle.cwd), { recursive: true, force: true });
  }

  /** Minimum age before sweep may touch a worktree; shields concurrent runtimes not in keepPaths. */
  static readonly SWEEP_MIN_AGE_MS = 60 * 60_000;

  /** True when every commit on `sha` is reachable from some ref other than `branch` itself. */
  private async isReachableElsewhere(baseCwd: string, sha: string, branch: string): Promise<boolean> {
    if (!sha) return false;
    const refs = await this.execFn(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "--contains", sha, "refs/heads", "refs/remotes", "refs/tags"],
      baseCwd,
    );
    if (refs.code !== 0) return false;
    return refs.stdout.split("\n").map((line) => line.trim()).filter(Boolean).some((ref) => ref !== branch);
  }

  /**
   * Garbage-collect leftovers for one repo:
   * - `git worktree prune` clears stale registrations (deleted directories).
   * - Clean worktrees whose commits are reachable elsewhere are removed (branch included).
   * - Anything holding unique work (dirty tree OR commits that exist on no other ref)
   *   is preserved until older than `retentionDays`; even then the worktree directory is
   *   removed but a branch with unique commits is NEVER deleted (0 keeps forever).
   * - Nothing younger than SWEEP_MIN_AGE_MS is touched (concurrent-runtime safety).
   * Never touches worktrees referenced by `keepPaths` (live runs).
   */
  async sweep(
    baseCwd: string,
    retentionDays = defaultConfig.worktreeRetentionDays,
    keepPaths: ReadonlySet<string> = new Set(),
    now = Date.now(),
  ): Promise<SweepReport> {
    const report: SweepReport = { pruned: false, removed: [], kept: [] };
    if (!(await this.isGitRepo(baseCwd))) return report;
    const pruned = await this.execFn("git", ["worktree", "prune"], baseCwd).catch(() => ({ code: 1 } as ExecResult));
    report.pruned = pruned.code === 0;

    const container = this.repoRoot(baseCwd);
    const entries = await fs.readdir(container, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(container, entry.name);
      const cwd = path.join(root, "work");
      if (keepPaths.has(cwd)) {
        report.kept.push(cwd);
        continue;
      }
      const stat = await fs.stat(cwd).catch(() => undefined);
      if (!stat) {
        // Orphaned container (work dir already gone).
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        report.removed.push(cwd);
        continue;
      }
      const age = now - stat.mtimeMs;
      if (age < WorktreeManager.SWEEP_MIN_AGE_MS) {
        // Too young: may belong to a concurrent runtime whose keepPaths we cannot see.
        report.kept.push(cwd);
        continue;
      }

      const branchResult = await this.execFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => undefined);
      const shaResult = await this.execFn("git", ["rev-parse", "HEAD"], cwd).catch(() => undefined);
      const statusResult = await this.execFn("git", ["status", "--porcelain"], cwd).catch(() => undefined);
      if (branchResult?.code !== 0 || shaResult?.code !== 0 || statusResult?.code !== 0) {
        // Unable to prove safety: keep.
        report.kept.push(cwd);
        continue;
      }
      const branch = branchResult.stdout.trim();
      const sha = shaResult.stdout.trim();
      const dirty = statusResult.stdout.trim().length > 0;
      const handle: WorktreeHandle = { cwd, branch, baseCwd, baseCommit: sha, changed: dirty };
      const uniqueCommits = !(await this.isReachableElsewhere(baseCwd, sha, branch));

      if (!dirty && !uniqueCommits) {
        // Fully redundant: clean tree, commits preserved on other refs.
        await this.forceRemove(handle).catch(() => {});
        report.removed.push(cwd);
        continue;
      }
      if (retentionDays > 0 && age > retentionDays * 24 * 60 * 60_000) {
        // Expired: drop the directory (uncommitted changes lapse with retention),
        // but never delete a branch holding commits that exist nowhere else.
        if (uniqueCommits) {
          await this.execFn("git", ["worktree", "remove", "--force", cwd], baseCwd).catch(() => {});
          await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        } else {
          await this.forceRemove(handle).catch(() => {});
        }
        report.removed.push(cwd);
      } else {
        report.kept.push(cwd);
      }
    }
    return report;
  }
}
