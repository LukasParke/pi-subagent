import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProcessLockManager,
  currentProcessIdentity,
  isProcessAlive,
  type ProcessIdentity,
  type SlotToken,
} from "../src/process-lock.js";

describe("ProcessLockManager", () => {
  let root: string;
  let locks: ProcessLockManager;
  let now = 1_000_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-locks-"));
    now = 1_000_000;
    // maxDepth: 1 → no depth reservation for the baseline concurrency tests.
    locks = new ProcessLockManager({
      rootDir: root,
      leaseMs: 5_000,
      maxGlobalActive: 2,
      maxDepth: 1,
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

  describe("depth-reserved global slots (3.1)", () => {
    let tierRoot: string;
    let tiered: ProcessLockManager;

    beforeEach(() => {
      tierRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-slots-"));
      // maxGlobalActive: 2, maxDepth: 2 → reservedFor(0)=1 so depth-0 budget is 1.
      // A depth-0 parent holding a slot leaves a reserved slot for depth-1 children.
      tiered = new ProcessLockManager({
        rootDir: tierRoot,
        maxGlobalActive: 2,
        maxDepth: 2,
        now: () => now,
      });
    });

    afterEach(() => {
      tiered.dispose();
      fs.rmSync(tierRoot, { recursive: true, force: true });
    });

    it("repro: flat full depth-0 pool starves nested children; tiers unblock", () => {
      // Pre-fix tragedy under a flat cap of 2: two depth-0 holders leave zero room
      // for a depth-1 child of a nested parent. Tiering reserves 1 slot for deeper
      // work, so depth-0 can only fill 1 and the nested child always admits.
      const d0a = tiered.tryAcquireGlobalSlot("parent-d0", 0);
      expect(d0a).toBeTruthy();
      // Second depth-0 competitive holder (the deadlock peer under a flat pool)
      // is rejected under tiers — that *is* the flip of the starvation:
      expect(() => tiered.tryAcquireGlobalSlot("peer-d0", 0)).toThrow(/machine-wide/i);
      // Depth-1 children of the nested parent still claim the reserved slot.
      const childA = tiered.tryAcquireGlobalSlot("child-a", 1);
      expect(childA).toBeTruthy();
      // Cap still applies: second concurrent depth-1 loses until someone releases.
      expect(() => tiered.tryAcquireGlobalSlot("child-b", 1)).toThrow(/machine-wide/i);
      tiered.releaseGlobalSlot(d0a);
      const childB = tiered.tryAcquireGlobalSlot("child-b", 1);
      expect(childB).toBeTruthy();
    });

    it("treats legacy slot files without depth as depth 0", () => {
      const legacyId = "legacy-depthless";
      const file = path.join(tierRoot, "slots", `${legacyId}.slot`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          slotId: legacyId,
          runId: "legacy",
          process: currentProcessIdentity(),
          acquiredAt: now,
        }),
      );
      // depth-0 budget is 1 and legacy counts as depth 0 → second depth-0 fails.
      expect(() => tiered.tryAcquireGlobalSlot("d0-next", 0)).toThrow(/machine-wide/i);
      // depth-1 still gets the reserved slot.
      expect(tiered.tryAcquireGlobalSlot("d1-ok", 1)).toBeTruthy();
    });

    it("single-level fanout fills the full cap when maxDepth is 1 (16-wide)", () => {
      const wideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-wide-"));
      const wide = new ProcessLockManager({
        rootDir: wideRoot,
        maxGlobalActive: 16,
        maxDepth: 1,
        now: () => now,
      });
      try {
        const tokens: Array<SlotToken | undefined> = [];
        for (let i = 0; i < 16; i++) {
          const t = wide.tryAcquireGlobalSlot(`leaf-${i}`, 0);
          expect(t).toBeTruthy();
          tokens.push(t);
        }
        expect(() => wide.tryAcquireGlobalSlot("leaf-overflow", 0)).toThrow(/machine-wide/i);
        for (const t of tokens) wide.releaseGlobalSlot(t);
      } finally {
        wide.dispose();
        fs.rmSync(wideRoot, { recursive: true, force: true });
      }
    });

    it("full-width depth-0 tree with spawning children completes under default maxDepth", () => {
      // Defaults-style: cap 16, maxDepth 2 → depth-0 budget 15; deepest uses remainder.
      const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-tree-"));
      const tree = new ProcessLockManager({
        rootDir: treeRoot,
        maxGlobalActive: 16,
        maxDepth: 2,
        now: () => now,
      });
      try {
        const parents: Array<SlotToken | undefined> = [];
        for (let i = 0; i < 15; i++) {
          const t = tree.tryAcquireGlobalSlot(`parent-${i}`, 0);
          expect(t, `parent-${i}`).toBeTruthy();
          parents.push(t);
        }
        expect(() => tree.tryAcquireGlobalSlot("parent-overflow", 0)).toThrow(/machine-wide/i);
        const child = tree.tryAcquireGlobalSlot("spawn-child", 1);
        expect(child).toBeTruthy();
        tree.releaseGlobalSlot(parents[0]);
        expect(tree.tryAcquireGlobalSlot("parent-backfill", 0)).toBeTruthy();
      } finally {
        tree.dispose();
        fs.rmSync(treeRoot, { recursive: true, force: true });
      }
    });
  });

  describe("session lock lease reclaim matrix (3.3)", () => {
    const leaseMs = 5_000;
    const hostLocal = os.hostname();
    const hostRemote = "other-host.example";

    type Case = {
      name: string;
      sameHost: boolean;
      /** Non-zero startTime + controlled isAlive means identity-verifiable. */
      identityVerifiable: boolean;
      /** isAlive when same-host (foreign hostpath never consults local liveliness). */
      alive?: boolean;
      /**
       * Lease relation to `now`:
       * - fresh:   leaseExpiresAt = now + leaseMs
       * - expired: leaseExpiresAt = now - 1  (one period already over)
       * - double:  leaseExpiresAt = now - leaseMs - 1 (beyond 2× window)
       */
      lease: "fresh" | "expired" | "double";
      expectOk: boolean;
    };

    const cases: Case[] = [
      {
        name: "same-host verifiable dead → reclaim immediate (lease irrelevant)",
        sameHost: true,
        identityVerifiable: true,
        alive: false,
        lease: "fresh",
        expectOk: true,
      },
      {
        name: "same-host verifiable live → keep even if lease soft-expired",
        sameHost: true,
        identityVerifiable: true,
        alive: true,
        lease: "double",
        expectOk: false,
      },
      {
        name: "same-host identity-unknown dead PID → reclaim immediate",
        sameHost: true,
        identityVerifiable: false,
        alive: false,
        lease: "fresh",
        expectOk: true,
      },
      {
        name: "same-host identity-unknown live, lease fresh → keep",
        sameHost: true,
        identityVerifiable: false,
        alive: true,
        lease: "fresh",
        expectOk: false,
      },
      {
        name: "same-host identity-unknown live, single lease expired → keep (2× window)",
        sameHost: true,
        identityVerifiable: false,
        alive: true,
        lease: "expired",
        expectOk: false,
      },
      {
        name: "same-host identity-unknown live, 2× lease expired → reclaim",
        sameHost: true,
        identityVerifiable: false,
        alive: true,
        lease: "double",
        expectOk: true,
      },
      {
        name: "cross-host lease fresh → keep (ignore local isAlive)",
        sameHost: false,
        identityVerifiable: true,
        alive: false,
        lease: "fresh",
        expectOk: false,
      },
      {
        name: "cross-host lease expired once → reclaim",
        sameHost: false,
        identityVerifiable: true,
        alive: true,
        lease: "expired",
        expectOk: true,
      },
      {
        name: "cross-host identity-unverifiable, lease expired once → reclaim",
        sameHost: false,
        identityVerifiable: false,
        alive: true,
        lease: "expired",
        expectOk: true,
      },
      {
        name: "cross-host lease double-expired → reclaim",
        sameHost: false,
        identityVerifiable: false,
        alive: false,
        lease: "double",
        expectOk: true,
      },
    ];

    it.each(cases)("$name", (c) => {
      const matrixRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lease-"));
      const aliveByPid = new Map<number, boolean>();
      const matrix = new ProcessLockManager({
        rootDir: matrixRoot,
        leaseMs,
        maxGlobalActive: 0,
        now: () => now,
        isAlive: (identity: ProcessIdentity) => aliveByPid.get(identity.pid) ?? false,
      });
      try {
        const first = matrix.acquireSessionLock("child-matrix", {
          ownerId: "original",
          runId: "run-original",
          parentSessionKey: "s",
        });
        expect(first.ok).toBe(true);

        const file = path.join(matrixRoot, "sessions", "child-matrix.lock");
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        const pid = 8_000_000 + Math.floor(Math.random() * 100_000);
        const leaseExpiresAt =
          c.lease === "fresh"
            ? now + leaseMs
            : c.lease === "expired"
              ? now - 1
              : now - leaseMs - 1;
        record.process = {
          pid,
          startTime: c.identityVerifiable ? 42 : 0,
          hostname: c.sameHost ? hostLocal : hostRemote,
        };
        record.leaseExpiresAt = leaseExpiresAt;
        fs.writeFileSync(file, JSON.stringify(record));
        if (c.alive !== undefined) aliveByPid.set(pid, c.alive);

        const claim = matrix.acquireSessionLock("child-matrix", {
          ownerId: "challenger",
          runId: "run-challenger",
          parentSessionKey: "s",
        });
        expect(claim.ok).toBe(c.expectOk);
        if (c.expectOk) {
          expect(claim.ok && claim.lock.runId).toBe("run-challenger");
        } else if (!claim.ok) {
          expect(claim.conflict.runId).toBe("run-original");
        }
      } finally {
        matrix.dispose();
        fs.rmSync(matrixRoot, { recursive: true, force: true });
      }
    });
  });
});
