import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { SessionScopedRunRegistry } from "../src/registry.js";
import { emptyUsage } from "../src/types.js";

const spec = { task: "test", profile: "general" as const, timeoutMs: 1000 };
const result = (sessionId?: string) => ({
  label: "task-1", task: "test", state: "completed" as const, exitCode: 0, messages: [], stderr: "", usage: { ...emptyUsage(), cost: 0.25 }, sessionId,
  protocol: { headerSeen: true, assistantEndSeen: true, agentEndSeen: true, validEvents: 3, parseErrors: 0 },
});

function makeRegistry(entries: any[] = []) {
  const adapter = { appendEntry: vi.fn((type, data) => entries.push({ type: "custom", customType: type, data })), getEntries: () => entries };
  return { registry: new SessionScopedRunRegistry({ ...defaultConfig, maxCompletedInMemory: 2 }, adapter), adapter };
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
