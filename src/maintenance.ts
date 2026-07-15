import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SessionSweepReport {
  removed: string[];
  kept: number;
}

/**
 * Remove child session files older than `retentionDays` whose session id is
 * not referenced by any run on the active branch. Referenced ids and files
 * younger than the window are always kept. `retentionDays <= 0` disables.
 */
export async function sweepSessionDir(
  sessionDir: string,
  referencedSessionIds: ReadonlySet<string>,
  retentionDays: number,
  now = Date.now(),
): Promise<SessionSweepReport> {
  const report: SessionSweepReport = { removed: [], kept: 0 };
  if (!retentionDays || retentionDays <= 0) return report;
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      report.kept++;
      continue;
    }
    const base = entry.name.slice(0, -".jsonl".length);
    const referenced = [...referencedSessionIds].some((id) => base === id || base.includes(id));
    if (referenced) {
      report.kept++;
      continue;
    }
    const file = path.join(sessionDir, entry.name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || stat.mtimeMs >= cutoff) {
      report.kept++;
      continue;
    }
    await fs.rm(file, { force: true }).catch(() => {});
    report.removed.push(file);
  }
  return report;
}

/** Resolve an aborted signal into a promise for Promise.race patterns. */
export function abortAsPromise(signal: AbortSignal | undefined): Promise<"aborted"> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
}
