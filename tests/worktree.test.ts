import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorktreeManager } from "../src/worktree.js";

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
  let mgr: WorktreeManager;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-git-"));
    await run("git", ["init"], repo);
    await run("git", ["config", "user.email", "test@example.com"], repo);
    await run("git", ["config", "user.name", "Test"], repo);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    await run("git", ["add", "."], repo);
    await run("git", ["commit", "-m", "init"], repo);
    mgr = new WorktreeManager();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
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

  it("rejects create outside git", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "not-git-"));
    try {
      await expect(mgr.create(tmp)).rejects.toThrow(/not a git repository/i);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
