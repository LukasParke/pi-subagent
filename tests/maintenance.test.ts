import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { abortAsPromise, sweepSessionDir } from "../src/maintenance.js";

describe("sweepSessionDir", () => {
  it("removes only old, unreferenced session files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-sessions-"));
    try {
      const old = path.join(dir, "old-session.jsonl");
      const referenced = path.join(dir, "kept-session.jsonl");
      const fresh = path.join(dir, "fresh-session.jsonl");
      const other = path.join(dir, "notes.txt");
      for (const file of [old, referenced, fresh, other]) await fs.writeFile(file, "{}\n");
      const past = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      await fs.utimes(old, past, past);
      await fs.utimes(referenced, past, past);

      const report = await sweepSessionDir(dir, new Set(["kept-session"]), 7);
      expect(report.removed).toEqual([old]);
      await expect(fs.stat(old)).rejects.toThrow();
      await fs.stat(referenced);
      await fs.stat(fresh);
      await fs.stat(other);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is disabled when retention is unset", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-sessions-"));
    try {
      const old = path.join(dir, "old.jsonl");
      await fs.writeFile(old, "{}\n");
      const past = new Date(Date.now() - 365 * 24 * 60 * 60_000);
      await fs.utimes(old, past, past);
      expect((await sweepSessionDir(dir, new Set(), 0)).removed).toEqual([]);
      await fs.stat(old);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing directory", async () => {
    const report = await sweepSessionDir("/nonexistent/pi-subagent-nowhere", new Set(), 7);
    expect(report).toEqual({ removed: [], kept: 0 });
  });
});

describe("abortAsPromise", () => {
  it("resolves for pre-aborted and later-aborted signals; undefined without a signal", async () => {
    expect(abortAsPromise(undefined)).toBeUndefined();
    const pre = new AbortController();
    pre.abort();
    await expect(abortAsPromise(pre.signal)).resolves.toBe("aborted");
    const later = new AbortController();
    const promise = abortAsPromise(later.signal)!;
    later.abort();
    await expect(promise).resolves.toBe("aborted");
  });
});
