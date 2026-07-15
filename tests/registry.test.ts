import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { ProcessLockManager } from "../src/process-lock.js";
import { PersistenceLayer, RUN_ENTRY_TYPE } from "../src/persistence.js";
import { SessionScopedRunRegistry } from "../src/registry.js";
import { emptyUsage } from "../src/types.js";

const spec = { task: "test", profile: "general" as const, timeoutMs: 1000 };
const result = (sessionId?: string) => ({
  label: "task-1", task: "test", state: "completed" as const, exitCode: 0, messages: [], stderr: "", usage: { ...emptyUsage(), cost: 0.25 }, sessionId,
  protocol: { headerSeen: true, assistantEndSeen: true, agentEndSeen: true, agentSettledSeen: true, validEvents: 3, parseErrors: 0 },
});

const lockRoots: string[] = [];

afterEach(() => {
  for (const root of lockRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRegistry(entries: any[] = [], withLocks = false) {
  const adapter = { appendEntry: vi.fn((type, data) => entries.push({ type: "custom", customType: type, data })), getEntries: () => entries };
  let locks: ProcessLockManager | undefined;
  if (withLocks) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-reg-locks-"));
    lockRoots.push(root);
    locks = new ProcessLockManager({ rootDir: root, maxGlobalActive: 0 });
  }
  return { registry: new SessionScopedRunRegistry({ ...defaultConfig, maxCompletedInMemory: 2 }, adapter, locks), adapter, locks };
}

describe("SessionScopedRunRegistry", () => {
  it("stores full UUIDs and resolves only unique prefixes", () => {
    const { registry } = makeRegistry();
    const id = registry.allocateRunId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    registry.start("s", "single", [spec], new AbortController(), Promise.resolve(), [], id);
    expect(registry.lookup(id, "s").status).toBe("found");
    expect(registry.lookup(id.slice(0, 10), "s").status).toBe("found");
  });

  it("reports deterministic ambiguous prefixes", () => {
    const { registry } = makeRegistry();
    const a = "aaaaaaaa-0000-4000-8000-000000000001";
    const b = "aaaaaaaa-0000-4000-8000-000000000002";
    registry.start("s", "single", [spec], new AbortController(), Promise.resolve(), [], a);
    registry.start("s", "single", [spec], new AbortController(), Promise.resolve(), [], b);
    const found = registry.lookup("aaaaaaaa", "s");
    expect(found.status).toBe("ambiguous");
    expect(found.matches).toEqual([a, b]);
  });

  it("keeps session ownership strict", () => {
    const { registry } = makeRegistry();
    const id = registry.start("a", "single", [spec], new AbortController(), Promise.resolve());
    expect(registry.lookup(id, "b").status).toBe("not-found");
    expect(registry.checkpoint(id, "b", { progress: "wrong" })).toBe(false);
    expect(registry.complete(id, "b", "failed")).toBe(false);
  });

  it("acquires direct resume locks atomically and allows fork bypass", () => {
    const { registry } = makeRegistry();
    const first = registry.allocateRunId();
    expect(registry.acquireResumeLocks(["child-a", "child-b"], first, "s").ok).toBe(true);
    const second = registry.allocateRunId();
    const conflict = registry.acquireResumeLocks(["child-c", "child-b"], second, "s");
    expect(conflict).toEqual({ ok: false, conflict: { sessionId: "child-b", runId: first } });
    expect(registry.acquireResumeLock("child-b", second, "s", true)).toBe(true);
    registry.releaseResumeLock("child-a", "s", first);
    expect(registry.acquireResumeLock("child-a", second, "s")).toBe(true);
  });

  it("durable locks reject cross-registry concurrent resumes of the same child session", () => {
    const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-shared-locks-"));
    lockRoots.push(sharedRoot);
    const locksA = new ProcessLockManager({ rootDir: sharedRoot, maxGlobalActive: 0 });
    const locksB = new ProcessLockManager({ rootDir: sharedRoot, maxGlobalActive: 0 });
    const entriesA: any[] = [];
    const entriesB: any[] = [];
    const adapterA = { appendEntry: vi.fn((type, data) => entriesA.push({ type: "custom", customType: type, data })), getEntries: () => entriesA };
    const adapterB = { appendEntry: vi.fn((type, data) => entriesB.push({ type: "custom", customType: type, data })), getEntries: () => entriesB };
    const regA = new SessionScopedRunRegistry({ ...defaultConfig, maxCompletedInMemory: 2 }, adapterA, locksA);
    const regB = new SessionScopedRunRegistry({ ...defaultConfig, maxCompletedInMemory: 2 }, adapterB, locksB);
    const runA = regA.allocateRunId();
    const runB = regB.allocateRunId();
    expect(regA.acquireResumeLocks(["shared-child"], runA, "s-a").ok).toBe(true);
    const conflict = regB.acquireResumeLocks(["shared-child"], runB, "s-b");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.conflict?.runId).toBe(runA);
    regA.releaseResumeLock("shared-child", "s-a", runA);
    expect(regB.acquireResumeLocks(["shared-child"], runB, "s-b").ok).toBe(true);
    locksA.dispose();
    locksB.dispose();
  });

  it("blocks resume of lost runs until clearResumeBlock", () => {
    const entries: any[] = [];
    const persistence = new PersistenceLayer({
      appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
      getEntries: () => entries,
    }, defaultConfig);
    persistence.persist("lost-run", "s", "start", {
      mode: "single",
      state: "running",
      startedAt: 1,
      taskPreviews: ["x"],
      results: [{ ...result("child-lost"), state: "running", exitCode: null }],
    });
    // Rebuild marks incomplete as lost + resumeBlocked.
    const rebuilt = new PersistenceLayer({
      appendEntry: () => {},
      getEntries: () => entries,
    }, defaultConfig).rebuild("s");
    expect(rebuilt.get("lost-run")?.state).toBe("lost");
    expect(rebuilt.get("lost-run")?.resumeBlocked).toBe(true);

    const { registry } = makeRegistry([...entries.map((e) => ({ ...e }))]);
    // Force snapshots via refresh (rebuilds from adapter entries).
    registry.refreshSnapshots("s");
    const snap = registry.getSnapshots("s").find((s) => s.id === "lost-run");
    expect(snap?.resumeBlocked).toBe(true);
    const blocked = registry.acquireResumeLocks(["child-lost"], registry.allocateRunId(), "s");
    expect(blocked.ok).toBe(false);
    registry.clearResumeBlock("lost-run", "s");
    expect(registry.acquireResumeLocks(["child-lost"], registry.allocateRunId(), "s").ok).toBe(true);
    void RUN_ENTRY_TYPE;
  });

  it("persists child session id immediately, independent of progress throttle", () => {
    const { registry, adapter } = makeRegistry();
    const id = registry.start("s", "single", [spec], new AbortController(), Promise.resolve());
    registry.checkpoint(id, "s", { resultIndex: 0, childSessionId: "child-1", resultUpdate: { sessionId: "child-1" } });
    const checkpoints = adapter.appendEntry.mock.calls.filter((call) => call[1].type === "checkpoint");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]![1].data.childSessionId).toBe("child-1");
  });

  it("delivers exactly once", () => {
    const { registry } = makeRegistry();
    const id = registry.start("s", "single", [spec], new AbortController(), Promise.resolve());
    registry.complete(id, "s", "completed", "done", [result()]);
    expect(registry.markDelivered(id, "s")).toBe(true);
    expect(registry.markDelivered(id, "s")).toBe(false);
  });

  it("caps terminal snapshots but terminal persistence retains usage", () => {
    const { registry, adapter } = makeRegistry();
    for (let i = 0; i < 4; i++) {
      const id = registry.start("s", "single", [spec], new AbortController(), Promise.resolve());
      registry.complete(id, "s", "completed", "done", [result()]);
    }
    expect(registry.getSnapshots("s")).toHaveLength(2);
    const terminals = adapter.appendEntry.mock.calls.filter((call) => call[1].type === "terminal");
    expect(terminals).toHaveLength(4);
    expect(terminals.reduce((sum, call) => sum + call[1].data.results[0].usage.cost, 0)).toBe(1);
  });

  it("refreshes terminal snapshots from the newly active branch", () => {
    const entries: any[] = [];
    const { registry } = makeRegistry(entries);
    const id = registry.start("s", "single", [spec], new AbortController(), Promise.resolve());
    registry.complete(id, "s", "completed", "done", [result()]);
    expect(registry.getSnapshots("s")).toHaveLength(1);
    entries.splice(0); // simulate /tree navigation to a branch without this run
    registry.refreshSnapshots("s");
    expect(registry.getSnapshots("s")).toHaveLength(0);
  });

  it("keeps checkpoint events lightweight and reserves transcripts for terminal", () => {
    const { registry, adapter } = makeRegistry();
    const id = registry.start("s", "single", [spec], new AbortController(), Promise.resolve());
    registry.checkpoint(id, "s", {
      resultIndex: 0,
      childSessionId: "child-1",
      resultUpdate: { sessionId: "child-1", transcript: "BIG-TRANSCRIPT", liveText: "BIG-LIVE" },
    });
    const checkpoint = adapter.appendEntry.mock.calls.find((call) => call[1].type === "checkpoint")![1];
    const persisted = JSON.stringify(checkpoint.data.results);
    expect(persisted).not.toContain("BIG-TRANSCRIPT");
    expect(persisted).not.toContain("BIG-LIVE");
    expect(checkpoint.data.results[0].sessionId).toBe("child-1");

    registry.complete(id, "s", "completed", "done", [{ ...result("child-1"), transcript: "BIG-TRANSCRIPT" } as any]);
    const terminal = adapter.appendEntry.mock.calls.find((call) => call[1].type === "terminal")![1];
    expect(JSON.stringify(terminal.data.results)).toContain("BIG-TRANSCRIPT");
  });

  it("coalesces live-text change events but flushes structural changes immediately", async () => {
    const { registry } = makeRegistry();
    const events: string[] = [];
    registry.subscribe((event) => events.push(event.type));
    const id = registry.start("s", "single", [spec], new AbortController(), Promise.resolve());
    registry.checkpoint(id, "s", { state: "running" }); // queued -> running flushes immediately
    events.length = 0;

    // Burst of live-text-only checkpoints: at most one coalesced emit.
    for (let i = 0; i < 25; i++) registry.checkpoint(id, "s", { resultUpdate: { liveText: `tick ${i}` } });
    expect(events.length).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.length).toBe(1);

    // Usage advance is structural and flushes immediately.
    registry.checkpoint(id, "s", { resultUpdate: { usage: { ...emptyUsage(), cost: 0.1, turns: 1 } } });
    expect(events.length).toBe(2);
    registry.complete(id, "s", "completed");
    expect(events).toContain("terminal");
  });

  it("tracks live worktree cwds for GC protection", () => {
    const { registry } = makeRegistry();
    const id = registry.start("s", "single", [{ ...spec, isolation: "worktree" as const, cwd: "/spec/cwd" }], new AbortController(), Promise.resolve());
    registry.checkpoint(id, "s", {
      resultUpdate: { worktree: { cwd: "/wt/work", branch: "pi-subagent/x", baseCommit: "abc", changed: false } },
    });
    const cwds = registry.getLiveWorktreeCwds("s");
    expect(cwds.has("/wt/work")).toBe(true);
    expect(cwds.has("/spec/cwd")).toBe(true);
  });

  it("shutdown aborts, awaits, and snapshots unresolved runs", async () => {
    const { registry } = makeRegistry();
    const controller = new AbortController();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    const id = registry.start("s", "single", [spec], controller, promise);
    controller.signal.addEventListener("abort", resolve);
    await registry.shutdown("s", 200);
    expect(controller.signal.aborted).toBe(true);
    expect(registry.getLiveRuns("s")).toHaveLength(0);
    expect(registry.lookup(id, "s").run).toMatchObject({ state: "cancelled" });
  });
});
