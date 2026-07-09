import { describe, it, expect, beforeEach, vi } from "vitest";
import { Semaphore } from "../src/semaphore.js";

describe("Semaphore", () => {
  let semaphore: Semaphore;

  beforeEach(() => {
    semaphore = new Semaphore(2, 5);
  });

  it("allows up to maxActive concurrent", async () => {
    const acquired: string[] = [];
    const promises = [];

    for (let i = 0; i < 4; i++) {
      promises.push(
        semaphore.acquire().then(() => {
          acquired.push(`task${i}`);
          setTimeout(() => semaphore.release(), 10);
        }),
      );
    }

    await Promise.all(promises.slice(0, 2));
    expect(acquired.length).toBe(2);

    await Promise.all(promises);
    expect(acquired.length).toBe(4);
  });

  it("respects maxQueued and rejects excess", async () => {
    await Promise.all([semaphore.acquire(), semaphore.acquire()]);

    const settled: Array<"ok" | "full"> = [];
    const waiters: Promise<void>[] = [];

    for (let i = 0; i < 5; i++) {
      waiters.push(
        semaphore.acquire().then(() => {
          settled.push("ok");
        }),
      );
    }

    await expect(semaphore.acquire()).rejects.toThrow(/queue full/i);

    for (let i = 0; i < 7; i++) semaphore.release();
    await Promise.all(waiters);
    expect(settled.length).toBe(5);
  });

  it("queued cancellation never invokes work", async () => {
    await Promise.all([semaphore.acquire(), semaphore.acquire()]);

    const ac = new AbortController();
    let ran = false;
    const promise = semaphore.acquire(ac.signal).then(() => {
      ran = true;
    });

    ac.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
    expect(ran).toBe(false);
    expect(semaphore.getStats().queued).toBe(0);

    // Free both active slots; aborted waiter must not run.
    semaphore.release();
    semaphore.release();
    expect(ran).toBe(false);
    expect(semaphore.getStats().active).toBe(0);
  });

  it("rejects already-aborted signals before enqueue", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(semaphore.acquire(ac.signal)).rejects.toThrow(/before enqueue/i);
    expect(semaphore.getStats()).toEqual({
      active: 0,
      queued: 0,
      maxActive: 2,
      maxQueued: 5,
    });
  });

  it("emits release event", async () => {
    let released = false;
    semaphore.on("release", () => {
      released = true;
    });

    await semaphore.acquire();
    semaphore.release();
    expect(released).toBe(true);
  });

  it("provides stats", () => {
    expect(semaphore.getStats()).toEqual({
      active: 0,
      queued: 0,
      maxActive: 2,
      maxQueued: 5,
    });
  });

  it("never starts work after aborted while waiting for a free slot", async () => {
    vi.useFakeTimers();
    try {
      await Promise.all([semaphore.acquire(), semaphore.acquire()]);
      const ac = new AbortController();
      let ran = false;
      const waiter = semaphore.acquire(ac.signal).then(() => {
        ran = true;
      });

      ac.abort();
      await expect(waiter).rejects.toThrow(/aborted/i);

      semaphore.release();
      await vi.advanceTimersByTimeAsync(20);
      expect(ran).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
