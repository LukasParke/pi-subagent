import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionBatcher } from "../src/notifications.js";

describe("CompletionBatcher", () => {
  let flushes: string[][];
  let batcher: CompletionBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushes = [];
    batcher = new CompletionBatcher((ids) => flushes.push(ids), { debounceMs: 100, maxWaitMs: 300 });
  });

  afterEach(() => {
    batcher.dispose();
    vi.useRealTimers();
  });

  it("batches successes completing within the debounce window", () => {
    batcher.add("a", false);
    vi.advanceTimersByTime(50);
    batcher.add("b", false);
    vi.advanceTimersByTime(50);
    batcher.add("c", false);
    expect(flushes).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(flushes).toEqual([["a", "b", "c"]]);
  });

  it("caps total hold time at maxWaitMs even under continuous completions", () => {
    batcher.add("a", false);
    // Keep resetting the debounce; the cap must still fire at 300ms.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(70);
      batcher.add(`r${i}`, false);
    }
    vi.advanceTimersByTime(70);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toContain("a");
  });

  it("failures flush immediately, carrying held successes", () => {
    batcher.add("ok-1", false);
    batcher.add("boom", true);
    expect(flushes).toEqual([["ok-1", "boom"]]);
  });

  it("deduplicates run ids", () => {
    batcher.add("a", false);
    batcher.add("a", false);
    vi.advanceTimersByTime(100);
    expect(flushes).toEqual([["a"]]);
  });

  it("dispose drops pending completions", () => {
    batcher.add("a", false);
    batcher.dispose();
    vi.advanceTimersByTime(1_000);
    expect(flushes).toHaveLength(0);
  });
});
