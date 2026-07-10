import type { Message } from "@earendil-works/pi-ai";
import type { RunSnapshot, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { RUN_ENTRY_TYPE } from "./persistence.js";

export interface UsageLedger {
  root: UsageStats;
  subagents: UsageStats;
  combined: UsageStats;
  runCount: number;
  taskCount: number;
}

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function normalizeUsage(value: Partial<UsageStats> | undefined): UsageStats {
  return {
    input: finite(value?.input),
    output: finite(value?.output),
    cacheRead: finite(value?.cacheRead),
    cacheWrite: finite(value?.cacheWrite),
    reasoning: finite(value?.reasoning),
    cost: finite(value?.cost),
    costInput: finite(value?.costInput),
    costOutput: finite(value?.costOutput),
    costCacheRead: finite(value?.costCacheRead),
    costCacheWrite: finite(value?.costCacheWrite),
    contextTokens: finite(value?.contextTokens),
    turns: finite(value?.turns),
  };
}

export function addUsage(...values: Array<Partial<UsageStats> | undefined>): UsageStats {
  return values.reduce<UsageStats>((sum, value) => {
    const next = normalizeUsage(value);
    sum.input += next.input;
    sum.output += next.output;
    sum.cacheRead += next.cacheRead;
    sum.cacheWrite += next.cacheWrite;
    sum.reasoning = (sum.reasoning ?? 0) + (next.reasoning ?? 0);
    sum.cost += next.cost;
    sum.costInput = (sum.costInput ?? 0) + (next.costInput ?? 0);
    sum.costOutput = (sum.costOutput ?? 0) + (next.costOutput ?? 0);
    sum.costCacheRead = (sum.costCacheRead ?? 0) + (next.costCacheRead ?? 0);
    sum.costCacheWrite = (sum.costCacheWrite ?? 0) + (next.costCacheWrite ?? 0);
    // Context size is a point-in-time measurement, not additive billed usage.
    if (next.contextTokens > 0) sum.contextTokens = next.contextTokens;
    sum.turns += next.turns;
    return sum;
  }, emptyUsage());
}

export function usageFromMessage(message: Message | unknown): UsageStats {
  const msg = message as { role?: string; usage?: any };
  if (msg?.role !== "assistant" || !msg.usage) return emptyUsage();
  const usage = msg.usage;
  const categoryTotal = [usage.cost?.input, usage.cost?.output, usage.cost?.cacheRead, usage.cost?.cacheWrite]
    .reduce((sum: number, value: unknown) => sum + finite(value), 0);
  const reportedTotal = typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0
    ? usage.cost.total
    : typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : categoryTotal;
  return normalizeUsage({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    cost: reportedTotal,
    costInput: usage.cost?.input,
    costOutput: usage.cost?.output,
    costCacheRead: usage.cost?.cacheRead,
    costCacheWrite: usage.cost?.cacheWrite,
    contextTokens: usage.totalTokens,
    turns: 1,
  });
}

/** Root usage from active-branch session message entries only. */
export function rootUsageFromEntries(entries: readonly unknown[]): UsageStats {
  const seenMessageEntries = new Set<string>();
  const usages: UsageStats[] = [];
  for (const raw of entries) {
    const entry = raw as { type?: string; id?: string; message?: Message };
    if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    if (entry.id && seenMessageEntries.has(entry.id)) continue;
    if (entry.id) seenMessageEntries.add(entry.id);
    usages.push(usageFromMessage(entry.message));
  }
  return addUsage(...usages);
}

/** Count each terminal snapshot once by full run ID. */
export function subagentUsageFromSnapshots(snapshots: Iterable<RunSnapshot>): {
  usage: UsageStats;
  runCount: number;
  taskCount: number;
} {
  const byId = new Map<string, RunSnapshot>();
  for (const snapshot of snapshots) byId.set(snapshot.id, snapshot);
  const runs = [...byId.values()];
  const taskUsages = runs.flatMap((run) => run.results.map((result) => result.usage));
  return { usage: addUsage(...taskUsages), runCount: runs.length, taskCount: taskUsages.length };
}

/**
 * Reconstruct cost directly from terminal persistence events on the active
 * branch. This remains complete even when old UI snapshots are evicted.
 */
interface RunUsage {
  usage: UsageStats;
  taskCount: number;
}

export function subagentUsageFromEntries(entries: readonly unknown[]): {
  usage: UsageStats;
  runCount: number;
  taskCount: number;
  runIds: Set<string>;
  byRun: Map<string, RunUsage>;
} {
  const latestById = new Map<string, { results: any[] }>();
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: any };
    if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE) continue;
    const event = entry.data;
    if (!event || event.schemaVersion !== 1 || typeof event.id !== "string") continue;
    // Start/checkpoint/terminal records carry cumulative task usage. Session
    // branch order is canonical, so the latest results replace earlier values.
    if (["start", "checkpoint", "terminal"].includes(event.type) && Array.isArray(event.data?.results)) {
      latestById.set(event.id, { results: event.data.results });
    }
  }
  const byRun = new Map<string, RunUsage>();
  for (const [id, run] of latestById) {
    const usages = run.results.map((result) => result.usage);
    byRun.set(id, { usage: addUsage(...usages), taskCount: usages.length });
  }
  return {
    usage: addUsage(...[...byRun.values()].map((run) => run.usage)),
    runCount: byRun.size,
    taskCount: [...byRun.values()].reduce((sum, run) => sum + run.taskCount, 0),
    runIds: new Set(byRun.keys()),
    byRun,
  };
}

function messageFingerprint(message: any): string {
  return JSON.stringify([
    message?.timestamp ?? null,
    message?.provider ?? null,
    message?.model ?? null,
    message?.responseId ?? null,
    message?.usage?.input ?? null,
    message?.usage?.output ?? null,
    message?.usage?.cacheRead ?? null,
    message?.usage?.cacheWrite ?? null,
    message?.usage?.cost?.total ?? null,
  ]);
}

export function buildUsageLedger(
  activeBranchEntries: readonly unknown[],
  currentSnapshots: Iterable<RunSnapshot> = [],
  pendingRootMessages: readonly Message[] = [],
): UsageLedger {
  const branchRoot = rootUsageFromEntries(activeBranchEntries);
  const branchFingerprintCounts = new Map<string, number>();
  for (const raw of activeBranchEntries as any[]) {
    if (raw?.type !== "message" || raw.message?.role !== "assistant") continue;
    const fingerprint = messageFingerprint(raw.message);
    branchFingerprintCounts.set(fingerprint, (branchFingerprintCounts.get(fingerprint) ?? 0) + 1);
  }
  const pending = pendingRootMessages.filter((message) => {
    const fingerprint = messageFingerprint(message);
    const remaining = branchFingerprintCounts.get(fingerprint) ?? 0;
    if (remaining === 0) return true;
    branchFingerprintCounts.set(fingerprint, remaining - 1);
    return false;
  });
  const root = addUsage(branchRoot, ...pending.map(usageFromMessage));
  const persisted = subagentUsageFromEntries(activeBranchEntries);
  // Current in-memory snapshots are newer than SessionManager visibility. They
  // replace the same run's persisted checkpoint, while unrelated runs remain.
  const currentById = new Map<string, RunSnapshot>();
  for (const snapshot of currentSnapshots) currentById.set(snapshot.id, snapshot);
  const persistedOnly = [...persisted.byRun.entries()].filter(([id]) => !currentById.has(id));
  const current = subagentUsageFromSnapshots(currentById.values());
  const subagents = addUsage(
    ...persistedOnly.map(([, run]) => run.usage),
    current.usage,
  );
  return {
    root,
    subagents,
    combined: addUsage(root, subagents),
    runCount: persistedOnly.length + current.runCount,
    taskCount: persistedOnly.reduce((sum, [, run]) => sum + run.taskCount, 0) + current.taskCount,
  };
}

export function formatLedger(ledger: UsageLedger): string {
  const money = (n: number) => `$${n.toFixed(4)}`;
  const tokens = (u: UsageStats) => `${u.input + u.output} tok`;
  return [
    `root ${money(ledger.root.cost)} (${tokens(ledger.root)})`,
    `subagents ${money(ledger.subagents.cost)} (${tokens(ledger.subagents)}, ${ledger.runCount} runs/${ledger.taskCount} tasks)`,
    `combined ${money(ledger.combined.cost)} (${tokens(ledger.combined)})`,
  ].join(" · ");
}
