import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProcessLockManager,
  currentProcessIdentity,
  isProcessAlive,
} from "../src/process-lock.js";

describe("ProcessLockManager", () => {
  let root: string;
  let locks: ProcessLockManager;
  let now = 1_000_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-locks-"));
    now = 1_000_000;
    locks = new ProcessLockManager({
      rootDir: root,
      leaseMs: 5_000,
      maxGlobalActive: 2,
      now: () => now,
    });
  });

  afterEach(() => {
    locks.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("grants exclusive session locks and detects conflicts", () => {
    const a = locks.acquireSessionLock("child-1", {
      ownerId: "owner-a",
      runId: "run-a",
      parentSessionKey: "s",
    });
    expect(a.ok).toBe(true);
    const b = locks.acquireSessionLock("child-1", {
      ownerId: "owner-b",
      runId: "run-b",
      parentSessionKey: "s",
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.conflict.runId).toBe("run-a");
    locks.releaseSessionLock("child-1", "run-a");
    const c = locks.acquireSessionLock("child-1", {
      ownerId: "owner-b",
      runId: "run-b",
      parentSessionKey: "s",
    });
    expect(c.ok).toBe(true);
  });

  it("reclaims locks whose owner process is dead", () => {
    const dead = locks.acquireSessionLock("child-dead", {
      ownerId: "dead-owner",
      runId: "run-dead",
      parentSessionKey: "s",
    });
    expect(dead.ok).toBe(true);
    // Overwrite with a fake dead process identity.
    const file = path.join(root, "sessions", "child-dead.lock");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.process = { pid: 999_999_999, startTime: 1, hostname: os.hostname() };
    fs.writeFileSync(file, JSON.stringify(record));

    const fresh = locks.acquireSessionLock("child-dead", {
      ownerId: "fresh",
      runId: "run-fresh",
      parentSessionKey: "s",
    });
    expect(fresh.ok).toBe(true);
  });

  it("enforces the machine-wide concurrency cap", () => {
    const a = locks.tryAcquireGlobalSlot("run-1");
    const b = locks.tryAcquireGlobalSlot("run-2");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(() => locks.tryAcquireGlobalSlot("run-3")).toThrow(/machine-wide/i);
    locks.releaseGlobalSlot(a);
    const c = locks.tryAcquireGlobalSlot("run-3");
    expect(c).toBeTruthy();
  });

  it("writes and reaps run records for dead orphans", async () => {
    locks.writeRunRecord({
      runId: "orphan-1",
      parentSessionKey: "s",
      childSessionId: "child-orphan",
      process: { pid: 999_999_998, startTime: 1, hostname: os.hostname() },
      startedAt: now,
      state: "running",
      updatedAt: now,
    });
    const report = await locks.reconcileOrphans({ parentSessionKey: "s" });
    expect(report.alreadyDead).toContain("orphan-1");
    const after = locks.readRunRecord("orphan-1");
    expect(after?.state).toBe("terminal");
  });

  it("reports current process as alive", () => {
    expect(isProcessAlive(currentProcessIdentity())).toBe(true);
  });
});
