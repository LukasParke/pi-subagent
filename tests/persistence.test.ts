import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { PersistenceLayer, RUN_ENTRY_TYPE } from "../src/persistence.js";

function adapterFor(entries: any[] = []) {
  return {
    entries,
    appendEntry: vi.fn((type, data) => entries.push({ type: "custom", customType: type, data })),
    getEntries: () => entries,
  };
}

const result = (cost = 0.5) => ({
  label: "task-1", task: "do", state: "completed" as const, exitCode: 0,
  usage: {
    input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3,
    cost, costInput: 0.2, costOutput: 0.25, costCacheRead: 0.03, costCacheWrite: 0.02,
    contextTokens: 18, turns: 1,
  },
  sessionId: "child-1", finalOutput: "done",
});

describe("PersistenceLayer", () => {
  it("folds start, checkpoint, terminal and delivered without losing state", () => {
    const adapter = adapterFor();
    const persistence = new PersistenceLayer(adapter, defaultConfig);
    persistence.persist("r", "s", "start", { mode: "parallel", state: "queued", startedAt: 10, taskPreviews: ["one"], results: [] });
    persistence.persist("r", "s", "checkpoint", { state: "running", resultIndex: 0, childSessionId: "child-1" });
    persistence.persist("r", "s", "terminal", { mode: "parallel", state: "completed", startedAt: 10, endedAt: 20, summary: "ok", taskPreviews: ["one"], results: [result()] });
    persistence.markDelivered("r", "s");
    const snapshot = persistence.rebuild("s").get("r")!;
    expect(snapshot).toMatchObject({ mode: "parallel", state: "completed", startedAt: 10, endedAt: 20, summary: "ok", delivered: true });
    expect(snapshot.results[0]).toMatchObject({ sessionId: "child-1", finalOutput: "done" });
    expect(snapshot.results[0]!.usage).toMatchObject({
      cost: 0.5, reasoning: 3, costInput: 0.2, costOutput: 0.25,
      costCacheRead: 0.03, costCacheWrite: 0.02,
    });
  });

  it("restores only active branch entries supplied by adapter", () => {
    const active = adapterFor();
    const p = new PersistenceLayer(active, defaultConfig);
    p.persist("active", "s", "terminal", { state: "completed", results: [result()] });
    const abandoned = {
      type: "custom", customType: RUN_ENTRY_TYPE,
      data: { schemaVersion: 1, id: "abandoned", sessionKey: "s", timestamp: 1, sequence: 1, type: "terminal", data: { state: "completed", results: [] } },
    };
    // Adapter intentionally does not include abandoned branch.
    expect(p.rebuild("s").has("active")).toBe(true);
    expect(p.rebuild("s").has(abandoned.data.id)).toBe(false);
  });

  it("marks only incomplete runs lost", () => {
    const adapter = adapterFor();
    const p = new PersistenceLayer(adapter, defaultConfig);
    p.persist("running", "s", "start", { state: "running" });
    p.persist("done", "s", "terminal", { state: "completed", results: [result()] });
    expect(p.rebuild("s").get("running")!.state).toBe("lost");
    expect(p.rebuild("s").get("done")!.state).toBe("completed");
  });

  it("ignores malformed and other-session entries", () => {
    const entries = [
      { type: "custom", customType: RUN_ENTRY_TYPE, data: { nope: true } },
      { type: "custom", customType: RUN_ENTRY_TYPE, data: { schemaVersion: 1, id: "x", sessionKey: "other", type: "terminal", timestamp: 1, sequence: 1, data: { state: "completed" } } },
    ];
    expect(new PersistenceLayer(adapterFor(entries), defaultConfig).rebuild("s").size).toBe(0);
  });

  it("uses monotonic event sequence even within one millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const adapter = adapterFor();
    const p = new PersistenceLayer(adapter, defaultConfig);
    p.persist("r", "s", "start", { state: "running" });
    p.persist("r", "s", "terminal", { state: "completed", results: [result()] });
    p.markDelivered("r", "s");
    const sequences = adapter.entries.map((entry: any) => entry.data.sequence);
    expect(sequences).toEqual([1, 2, 3]);
    expect(p.rebuild("s").get("r")!.delivered).toBe(true);
    vi.restoreAllMocks();
  });
});
