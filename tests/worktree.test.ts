import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { INCLUDES_PARENT_WIP, WorktreeManager } from "../src/worktree.js";

async function run(cmd: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("WorktreeManager", () => {
  let repo: string;
  let root: string;
  let mgr: WorktreeManager;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-git-"));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wt-root-"));
    await run("git", ["init"], repo);
    await run("git", ["config", "user.email", "test@example.com"], repo);
    await run("git", ["config", "user.name", "Test"], repo);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    await run("git", ["add", "."], repo);
    await run("git", ["commit", "-m", "init"], repo);
    mgr = new WorktreeManager(undefined, root);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("detects non-git dirs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "not-git-"));
    try {
      expect(await mgr.isGitRepo(tmp)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("creates a worktree on a unique branch", async () => {
    const handle = await mgr.create(repo, "edit");
    expect(handle.cwd).toBeTruthy();
    expect(handle.branch.startsWith("pi-subagent/")).toBe(true);
    const st = await fs.stat(handle.cwd);
    expect(st.isDirectory()).toBe(true);
    await mgr.forceRemove(handle);
  });

  it("auto-cleans unchanged worktrees and preserves uncommitted changes", async () => {
    const clean = await mgr.create(repo, "clean");
    const cleaned = await mgr.finalize(clean);
    expect(cleaned.changed).toBe(false);
    await expect(fs.stat(clean.cwd)).rejects.toThrow();

    const dirty = await mgr.create(repo, "dirty");
    await fs.writeFile(path.join(dirty.cwd, "extra.txt"), "change\n");
    const preserved = await mgr.finalize(dirty);
    expect(preserved.changed).toBe(true);
    await fs.stat(preserved.cwd);
    await mgr.forceRemove(preserved);
  });

  it("preserves committed child changes and branch", async () => {
    const committed = await mgr.create(repo, "committed");
    await fs.writeFile(path.join(committed.cwd, "committed.txt"), "important\n");
    await run("git", ["add", "."], committed.cwd);
    await run("git", ["commit", "-m", "child work"], committed.cwd);
    const preserved = await mgr.finalize(committed);
    expect(preserved.changed).toBe(true);
    await fs.stat(preserved.cwd);
    const branch = await run("git", ["show-ref", "--verify", `refs/heads/${preserved.branch}`], repo);
    expect(branch.code).toBe(0);
    await mgr.forceRemove(preserved);
  });

  it("diff reports committed and uncommitted changes with truncation", async () => {
    const handle = await mgr.create(repo, "diffme");
    await fs.writeFile(path.join(handle.cwd, "committed.txt"), "committed change\n");
    await run("git", ["add", "."], handle.cwd);
    await run("git", ["commit", "-m", "child commit"], handle.cwd);
    await fs.writeFile(path.join(handle.cwd, "uncommitted.txt"), "working change\n");

    const diff = await mgr.diff(handle);
    expect(diff.stat).toContain("committed.txt");
    expect(diff.patch).toContain("committed change");
    expect(diff.patch).toContain("working change");
    expect(diff.truncated).toBe(false);

    const tiny = await mgr.diff(handle, 10);
    expect(tiny.truncated).toBe(true);
    expect(Buffer.byteLength(tiny.patch, "utf8")).toBeLessThanOrEqual(10);
    await mgr.forceRemove(handle);
  });

  it("apply lands worktree changes as uncommitted changes in the base repo", async () => {
    const handle = await mgr.create(repo, "applyme");
    await fs.writeFile(path.join(handle.cwd, "feature.txt"), "new feature\n");
    await run("git", ["add", "."], handle.cwd);
    await run("git", ["commit", "-m", "feature"], handle.cwd);
    await fs.writeFile(path.join(handle.cwd, "README.md"), "hello\nedited\n");

    const result = await mgr.apply(handle, repo);
    expect(result.applied).toBe(true);

    // Applied as working-tree changes, not commits.
    expect((await fs.readFile(path.join(repo, "feature.txt"), "utf8"))).toBe("new feature\n");
    expect((await fs.readFile(path.join(repo, "README.md"), "utf8"))).toContain("edited");
    const log = await run("git", ["log", "--oneline"], repo);
    expect(log.stdout.trim().split("\n")).toHaveLength(1); // still only the init commit
    const status = await run("git", ["status", "--porcelain"], repo);
    expect(status.stdout).toContain("feature.txt");

    // Worktree survives apply (discard is a separate explicit step).
    await fs.stat(handle.cwd);
    await mgr.forceRemove(handle);
  });

  it("apply is a no-op when the worktree has no changes", async () => {
    const handle = await mgr.create(repo, "noop");
    const result = await mgr.apply(handle, repo);
    expect(result.applied).toBe(false);
    await mgr.forceRemove(handle);
  });

  it("rejects create outside git", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "not-git-"));
    try {
      await expect(mgr.create(tmp)).rejects.toThrow(/not a git repository/i);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("stores worktrees under the durable root, not the OS tmpdir default", async () => {
    const handle = await mgr.create(repo, "durable");
    expect(handle.cwd.startsWith(root)).toBe(true);
    expect(handle.cwd.startsWith(mgr.repoRoot(repo))).toBe(true);
    await mgr.forceRemove(handle);
  });

  it("sweep never deletes branches whose commits exist nowhere else", async () => {
    // Child committed work, working tree clean, run crashed before delivery.
    const committed = await mgr.create(repo, "committed-orphan");
    await fs.writeFile(path.join(committed.cwd, "work.txt"), "important\n");
    await run("git", ["add", "."], committed.cwd);
    await run("git", ["commit", "-m", "unmerged child work"], committed.cwd);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    await fs.utimes(committed.cwd, old, old);

    const report = await mgr.sweep(repo, 7, new Set());
    expect(report.kept).toContain(committed.cwd);
    // Branch and commits must survive.
    const branch = await run("git", ["show-ref", "--verify", `refs/heads/${committed.branch}`], repo);
    expect(branch.code).toBe(0);
    await mgr.forceRemove(committed);
  });

  it("sweep skips worktrees younger than the safety window", async () => {
    const fresh = await mgr.create(repo, "fresh"); // unchanged but just created
    const report = await mgr.sweep(repo, 7, new Set());
    expect(report.kept).toContain(fresh.cwd);
    expect(report.removed).not.toContain(fresh.cwd);
    await fs.stat(fresh.cwd);
    await mgr.forceRemove(fresh);
  });

  it("sweep removes unchanged leftovers and keeps changed + live worktrees", async () => {
    const stale = await mgr.create(repo, "stale"); // unchanged orphan
    const changed = await mgr.create(repo, "changed");
    await fs.writeFile(path.join(changed.cwd, "keep.txt"), "work\n");
    const live = await mgr.create(repo, "live");
    // Age both candidates past the safety window; live stays fresh but is shielded anyway.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    await fs.utimes(stale.cwd, old, old);
    await fs.utimes(changed.cwd, old, old);

    const report = await mgr.sweep(repo, 7, new Set([live.cwd]));
    expect(report.removed).toContain(stale.cwd);
    expect(report.kept).toContain(changed.cwd);
    expect(report.kept).toContain(live.cwd);
    await expect(fs.stat(stale.cwd)).rejects.toThrow();
    await fs.stat(changed.cwd);
    await fs.stat(live.cwd);

    // Expired changed worktrees are swept once past retention.
    const expired = await mgr.sweep(repo, 7, new Set([live.cwd]), Date.now() + 8 * 24 * 60 * 60_000);
    expect(expired.removed).toContain(changed.cwd);
    expect(expired.kept).toContain(live.cwd);

    await mgr.forceRemove(live);
  });

  async function makeDirtyParent(): Promise<void> {
    // Staged + unstaged + untracked — the full dirty-baseline surface.
    await fs.writeFile(path.join(repo, "README.md"), "hello\nstaged edit\n");
    await run("git", ["add", "README.md"], repo);
    await fs.writeFile(path.join(repo, "README.md"), "hello\nstaged edit\nunstaged too\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "parent untracked\n");
  }

  it("includeWip seeds staged, unstaged, and untracked parent changes", async () => {
    await makeDirtyParent();
    const handle = await mgr.create(repo, "wip-seed", undefined, { includeWip: true });
    expect(handle.wipPatch).toBeTruthy();
    expect(handle.wipUntracked).toContain("untracked.txt");
    expect(await fs.readFile(path.join(handle.cwd, "README.md"), "utf8")).toContain("unstaged too");
    expect(await fs.readFile(path.join(handle.cwd, "untracked.txt"), "utf8")).toBe("parent untracked\n");
    await mgr.forceRemove(handle);
  });

  it("diff on an untouched WIP-seeded worktree reports no agent changes", async () => {
    await makeDirtyParent();
    const handle = await mgr.create(repo, "wip-diff", undefined, { includeWip: true });
    const diff = await mgr.diff(handle);
    expect(diff.patch.trim()).toBe("");
    expect(diff.stat).toBe("");
    expect(diff.warning).toBeUndefined();
    await mgr.forceRemove(handle);
  });

  it("apply lands only agent changes when WIP subtraction is clean", async () => {
    await makeDirtyParent();
    const handle = await mgr.create(repo, "wip-apply", undefined, { includeWip: true });
    // Agent-only file (not part of parent WIP) keeps reverse-subtraction clean.
    await fs.writeFile(path.join(handle.cwd, "agent-only.txt"), "agent work\n");

    const result = await mgr.apply(handle, repo);
    expect(result.applied).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(await fs.readFile(path.join(repo, "agent-only.txt"), "utf8")).toBe("agent work\n");
    // Parent WIP files are not re-applied / recreated: untracked was already on parent,
    // and README content stays the parent's (no extra agent line).
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("hello\nstaged edit\nunstaged too\n");
    expect(await fs.readFile(path.join(repo, "untracked.txt"), "utf8")).toBe("parent untracked\n");
    await mgr.forceRemove(handle);
  });

  it("finalize treats untouched WIP-seeded worktree as unchanged", async () => {
    await makeDirtyParent();
    const handle = await mgr.create(repo, "wip-final", undefined, { includeWip: true });
    const final = await mgr.finalize(handle);
    expect(final.changed).toBe(false);
    await expect(fs.stat(handle.cwd)).rejects.toThrow();
  });

  it("diff falls back to combined delta with parent-WIP warning when subtraction cannot clean", async () => {
    await makeDirtyParent();
    const handle = await mgr.create(repo, "wip-fallback", undefined, { includeWip: true });
    // Corrupt stored baseline so reverse-apply is no longer exact.
    const root = path.dirname(handle.cwd);
    await fs.writeFile(path.join(root, "wip.patch"), "diff --git a/nope b/nope\nindex 111..222 100644\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
    handle.wipPatch = undefined; // force reload of corrupted artifact
    await fs.writeFile(path.join(handle.cwd, "agent-only.txt"), "agent work\n");
    const diff = await mgr.diff({ cwd: handle.cwd, baseCommit: handle.baseCommit, baseCwd: handle.baseCwd });
    expect(diff.warning).toBe(INCLUDES_PARENT_WIP);
    expect(diff.patch).toContain("agent work");
    // Combined path still contains parent WIP markers (e.g. unstaged too / untracked).
    expect(diff.patch.includes("unstaged too") || diff.patch.includes("untracked") || diff.patch.includes("parent untracked")).toBe(true);
    await mgr.forceRemove(handle);
  });

  it("default create does not seed parent WIP", async () => {
    await makeDirtyParent();
    const handle = await mgr.create(repo, "no-wip");
    expect(handle.wipPatch).toBeUndefined();
    expect(await fs.readFile(path.join(handle.cwd, "README.md"), "utf8")).toBe("hello\n");
    await expect(fs.stat(path.join(handle.cwd, "untracked.txt"))).rejects.toThrow();
    await mgr.forceRemove(handle);
  });
});
