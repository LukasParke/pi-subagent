import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTasks } from "../src/orchestrator.js";
import { ProcessLockManager } from "../src/process-lock.js";
import { runSubagent } from "../src/runner.js";
import type { TaskResult } from "../src/types.js";
import { WorktreeManager } from "../src/worktree.js";

/**
 * Manual real-Pi E2E for runner-level changes (PLAN ground rule 6).
 *
 * Skipped unless REAL_PI_E2E=1: spends real provider tokens and needs a
 * working `pi` on PATH with credentials. Run with:
 *
 *   REAL_PI_E2E=1 npx vitest run tests/real-pi.e2e.test.ts --testTimeout=600000
 *
 * Covers PLAN 3.2 (include_wip worktrees through a real child) and PLAN 3.1
 * (nested spawn with depth-tiered global slots through a real grandchild).
 */
const enabled = process.env.REAL_PI_E2E === "1";
const CHEAP_MODEL = "openrouter/google/gemini-2.5-flash-lite";
const TOOL_MODEL = "openrouter/google/gemini-2.5-flash";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function finalAssistantText(result: TaskResult): string {
  return `${result.transcript ?? ""}\n${result.liveText ?? ""}`;
}

describe.skipIf(!enabled)("real-Pi E2E (manual)", () => {
  let root: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-subagent-e2e-"));
    for (const key of [
      "PI_SUBAGENT_BIN",
      "PI_SUBAGENT_LOCK_DIR",
      "PI_SUBAGENT_SESSION_DIR",
      "PI_SUBAGENT_MAX_GLOBAL_ACTIVE",
      "PI_SUBAGENT_DEPTH",
      "PI_SUBAGENT_SPAWNS",
    ]) {
      savedEnv[key] = process.env[key];
    }
    // Pin the real CLI (argv[1] points at vitest here) and confine durable
    // state to the temp root; children inherit these via process.env.
    process.env.PI_SUBAGENT_BIN = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    process.env.PI_SUBAGENT_LOCK_DIR = path.join(root, "locks");
    process.env.PI_SUBAGENT_SESSION_DIR = path.join(root, "sessions");
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_SPAWNS;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  function makeDirtyRepo(name: string): string {
    const repo = path.join(root, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "e2e@test");
    git(repo, "config", "user.name", "E2E");
    fs.writeFileSync(path.join(repo, "a.txt"), "base line\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "base");
    // Dirty baseline: unstaged edit + staged new file + untracked file.
    fs.writeFileSync(path.join(repo, "a.txt"), "base line\nparent unstaged edit\n");
    fs.writeFileSync(path.join(repo, "staged.txt"), "parent staged\n");
    git(repo, "add", "staged.txt");
    fs.writeFileSync(path.join(repo, "wip-note.txt"), "WIP-MARKER-73519\n");
    return repo;
  }

  it("3.2: include_wip child sees parent WIP; diff reports agent-only changes", { timeout: 300_000 }, async () => {
    const repo = makeDirtyRepo("wip-visible");
    const worktrees = new WorktreeManager(undefined, path.join(root, "worktrees"));

    const run = await runTasks(
      [{
        task:
          "Read the file wip-note.txt in your working directory and repeat its exact content. " +
          "Then create a new file agent-file.txt containing exactly: AGENT-WAS-HERE. " +
          "Do not modify or delete any other file.",
        profile: "general",
        canWrite: true,
        isolation: "worktree",
        includeWip: true,
        cwd: repo,
        model: TOOL_MODEL,
        timeoutMs: 240_000,
      }],
      { worktrees, sessionDir: path.join(root, "sessions") },
    );

    const result = run.results[0]!;
    expect(result.state).toBe("completed");
    // Child could only know the marker by seeing the parent's untracked WIP file.
    expect(finalAssistantText(result)).toContain("WIP-MARKER-73519");

    // Agent created a file → worktree preserved as changed.
    expect(result.worktree?.changed).toBe(true);
    const diff = await worktrees.diff({
      cwd: result.worktree!.cwd,
      baseCommit: result.worktree!.baseCommit,
      baseCwd: repo,
    });
    expect(diff.warning).toBeUndefined();
    expect(diff.patch).toContain("agent-file.txt");
    expect(diff.patch).not.toContain("wip-note.txt");
    expect(diff.patch).not.toContain("staged.txt");
    expect(diff.patch).not.toContain("parent unstaged edit");
  });

  it("3.2: untouched WIP-seeded worktree finalizes as unchanged", { timeout: 300_000 }, async () => {
    const repo = makeDirtyRepo("wip-untouched");
    const worktrees = new WorktreeManager(undefined, path.join(root, "worktrees"));

    const run = await runTasks(
      [{
        task: "Reply with exactly: DONE. Do not create, modify, or delete any files.",
        profile: "explore",
        isolation: "worktree",
        includeWip: true,
        cwd: repo,
        model: CHEAP_MODEL,
        timeoutMs: 240_000,
      }],
      { worktrees, sessionDir: path.join(root, "sessions") },
    );

    const result = run.results[0]!;
    expect(result.state).toBe("completed");
    // WIP-only worktree counts as unchanged → cleaned up, not preserved.
    expect(result.worktree).toBeUndefined();
  });

  it("3.1: nested spawn completes under a small tiered global cap; slot files record depth", { timeout: 600_000 }, async () => {
    const lockDir = process.env.PI_SUBAGENT_LOCK_DIR!;
    // Cap 3, maxDepth 2 → depth-0 budget 2, depth-1 budget 3: a parent plus
    // its grandchild always fit. Child extension reads the same cap/dir from env.
    process.env.PI_SUBAGENT_MAX_GLOBAL_ACTIVE = "3";
    const locks = new ProcessLockManager({ rootDir: lockDir, maxGlobalActive: 3, maxDepth: 2 });

    const slotDepths = new Set<number>();
    // Real timer, deliberately: slot files are written by separate real Pi
    // processes — fake timers cannot advance another process's clock, so we
    // sample the shared lock dir on the platform clock while the tree runs.
    const sampler = setInterval(() => {
      const dir = path.join(lockDir, "slots");
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
          slotDepths.add(typeof data.depth === "number" ? data.depth : 0);
        } catch { /* slot released mid-read */ }
      }
    }, 250);

    try {
      const result = await runSubagent(
        {
          task:
            'You have a tool named "subagent". Call it exactly once with these parameters: ' +
            '{"task": "Reply with exactly: NESTED-PONG", "model": "' + CHEAP_MODEL + '", "profile": "explore"}. ' +
            "Wait for its result, then repeat the child's final output verbatim in your final answer.",
          profile: "general",
          cwd: root,
          model: TOOL_MODEL,
          timeoutMs: 480_000,
        },
        {
          locks,
          runId: "e2e-nested",
          parentSessionKey: "e2e",
          sessionDir: path.join(root, "sessions"),
        },
      );

      expect(result.state).toBe("completed");
      // The marker can only come from the grandchild through the child's tool call.
      expect(finalAssistantText(result)).toContain("NESTED-PONG");
      // Both tiers held slots: parent at depth 0, grandchild at depth 1.
      expect(slotDepths.has(0)).toBe(true);
      expect(slotDepths.has(1)).toBe(true);
    } finally {
      clearInterval(sampler);
    }
  });
});
