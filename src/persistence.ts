import { Buffer } from "node:buffer";
import type { SubagentConfig } from "./config.js";
import type { RunMode, RunSnapshot, RunState, TaskProfile, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";

export const RUN_ENTRY_TYPE = "subagent-run-v1";

export interface PersistenceAdapter {
  /** Append to the currently-owned parent session. Implementations must reject stale ownership. */
  appendEntry(type: string, payload: unknown): void;
  /** Active-branch entries only, in branch order. */
  getEntries(): Array<{ type?: string; customType?: string; data?: unknown; timestamp?: number }>;
}

export interface PersistedResult {
  label: string;
  task: string;
  state: RunState;
  exitCode: number | null;
  stopReason?: string;
  errorMessage?: string;
  usage: UsageStats;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  profile?: TaskProfile;
  canWrite?: boolean;
  outputFile?: string;
  outputMode?: "inline" | "file-only";
  worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
  sessionId?: string;
  finalOutput?: string;
  transcript?: string;
}

export interface PersistenceEventData {
  mode?: RunMode;
  state?: RunState;
  startedAt?: number;
  endedAt?: number;
  taskPreviews?: string[];
  summary?: string;
  delivered?: boolean;
  results?: PersistedResult[];
  resultIndex?: number;
  childSessionId?: string;
  progress?: string;
  turn?: number;
}

export interface PersistenceEvent {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  timestamp: number;
  sequence: number;
  type: "start" | "checkpoint" | "terminal" | "delivered" | "dismissed";
  data: PersistenceEventData;
}

function isRunState(value: unknown): value is RunState {
  return ["queued", "running", "completed", "partial", "failed", "cancelled", "lost"].includes(
    String(value),
  );
}

function isRunMode(value: unknown): value is RunMode {
  return value === "single" || value === "parallel";
}

function normalizeUsage(value: unknown): UsageStats {
  if (!value || typeof value !== "object") return emptyUsage();
  const input = value as Partial<UsageStats>;
  const finite = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  return {
    input: finite(input.input),
    output: finite(input.output),
    cacheRead: finite(input.cacheRead),
    cacheWrite: finite(input.cacheWrite),
    reasoning: finite(input.reasoning),
    cost: finite(input.cost),
    costInput: finite(input.costInput),
    costOutput: finite(input.costOutput),
    costCacheRead: finite(input.costCacheRead),
    costCacheWrite: finite(input.costCacheWrite),
    contextTokens: finite(input.contextTokens),
    turns: finite(input.turns),
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function normalizeResult(value: unknown): PersistedResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<PersistedResult>;
  if (typeof r.label !== "string" || typeof r.task !== "string") return undefined;
  return {
    label: r.label,
    task: r.task,
    state: isRunState(r.state) ? r.state : "running",
    exitCode: typeof r.exitCode === "number" || r.exitCode === null ? r.exitCode : null,
    stopReason: typeof r.stopReason === "string" ? r.stopReason : undefined,
    errorMessage: typeof r.errorMessage === "string" ? utf8Prefix(r.errorMessage, 2_000) : undefined,
    usage: normalizeUsage(r.usage),
    model: typeof r.model === "string" ? r.model : undefined,
    thinking: ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(r.thinking)) ? r.thinking : undefined,
    profile: ["explore", "review", "general"].includes(String(r.profile)) ? r.profile : undefined,
    canWrite: typeof r.canWrite === "boolean" ? r.canWrite : undefined,
    outputFile: typeof r.outputFile === "string" ? r.outputFile : undefined,
    outputMode: r.outputMode === "file-only" ? "file-only" : r.outputMode === "inline" ? "inline" : undefined,
    worktree:
      r.worktree &&
      typeof r.worktree.cwd === "string" &&
      typeof r.worktree.branch === "string" &&
      typeof r.worktree.baseCommit === "string"
        ? { ...r.worktree, changed: r.worktree.changed === true }
        : undefined,
    sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
    finalOutput: typeof r.finalOutput === "string" ? utf8Prefix(r.finalOutput, 16_384) : undefined,
    transcript: typeof r.transcript === "string" ? utf8Prefix(r.transcript, 32_768) : undefined,
  };
}

function unwrapEvent(entry: { type?: string; customType?: string; data?: unknown }): PersistenceEvent | undefined {
  if (entry.customType !== RUN_ENTRY_TYPE && entry.type !== RUN_ENTRY_TYPE) return undefined;
  const raw = entry.data as Partial<PersistenceEvent> | undefined;
  if (!raw || raw.schemaVersion !== 1 || typeof raw.id !== "string" || typeof raw.sessionKey !== "string") {
    return undefined;
  }
  if (!["start", "checkpoint", "terminal", "delivered", "dismissed"].includes(String(raw.type))) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    sessionKey: raw.sessionKey,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
    sequence: typeof raw.sequence === "number" ? raw.sequence : 0,
    type: raw.type as PersistenceEvent["type"],
    data: raw.data && typeof raw.data === "object" ? raw.data : {},
  };
}

/**
 * Versioned event persistence. Restoration folds every event on the active branch,
 * rather than treating the latest delta as a complete snapshot.
 */
export class PersistenceLayer {
  private sequence = 0;

  constructor(
    private readonly adapter: PersistenceAdapter,
    private readonly config: SubagentConfig,
  ) {
    for (const entry of adapter.getEntries()) {
      const event = unwrapEvent(entry);
      if (event) this.sequence = Math.max(this.sequence, event.sequence);
    }
  }

  persist(
    id: string,
    sessionKey: string,
    type: PersistenceEvent["type"],
    data: PersistenceEventData,
    _terminalHint?: boolean,
  ): void {
    if (!id || !sessionKey) return;
    const event: PersistenceEvent = {
      schemaVersion: 1,
      id,
      sessionKey,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      type,
      data,
    };
    this.adapter.appendEntry(RUN_ENTRY_TYPE, event);
  }

  /** Fold active-branch events in their session order. */
  rebuild(sessionKey: string): Map<string, RunSnapshot> {
    const snapshots = new Map<string, RunSnapshot>();

    for (const entry of this.adapter.getEntries()) {
      const event = unwrapEvent(entry);
      if (!event || event.sessionKey !== sessionKey) continue;

      let snapshot = snapshots.get(event.id);
      if (!snapshot) {
        snapshot = {
          schemaVersion: 1,
          id: event.id,
          sessionKey,
          mode: "single",
          state: "running",
          startedAt: event.timestamp || Date.now(),
          taskPreviews: [],
          delivered: false,
          results: [],
        };
      }

      const d = event.data;
      if (isRunMode(d.mode)) snapshot.mode = d.mode;
      if (isRunState(d.state)) snapshot.state = d.state;
      if (typeof d.startedAt === "number") snapshot.startedAt = d.startedAt;
      if (typeof d.endedAt === "number") snapshot.endedAt = d.endedAt;
      if (Array.isArray(d.taskPreviews) && d.taskPreviews.every((x) => typeof x === "string")) {
        snapshot.taskPreviews = [...d.taskPreviews];
      }
      if (typeof d.summary === "string") snapshot.summary = d.summary;
      if (typeof d.delivered === "boolean") snapshot.delivered = d.delivered;
      if (Array.isArray(d.results)) {
        snapshot.results = d.results.map(normalizeResult).filter((r): r is PersistedResult => !!r);
      }

      if (event.type === "checkpoint" && typeof d.childSessionId === "string") {
        const index = typeof d.resultIndex === "number" ? d.resultIndex : 0;
        const result = snapshot.results[index];
        if (result) result.sessionId = d.childSessionId;
      }
      if (event.type === "delivered" || event.type === "dismissed") snapshot.delivered = true;

      snapshots.set(event.id, snapshot);
    }

    for (const [id, snapshot] of snapshots) {
      if (snapshot.state === "running" || snapshot.state === "queued") {
        snapshots.set(id, {
          ...snapshot,
          state: "lost",
          endedAt: Date.now(),
          summary: snapshot.summary || "Run was interrupted before the parent session completed.",
        });
      }
    }

    return snapshots;
  }

  markDelivered(id: string, sessionKey: string): void {
    this.persist(id, sessionKey, "delivered", { delivered: true });
  }

  /** Non-destructive planner. Filesystem scanning/deletion is intentionally outside persistence. */
  planRetention(referencedSessionIds: Set<string>): { keep: string[]; candidates: string[] } {
    if (!this.config.sessionRetentionDays || this.config.sessionRetentionDays <= 0) {
      return { keep: Array.from(referencedSessionIds), candidates: [] };
    }
    return { keep: Array.from(referencedSessionIds), candidates: [] };
  }
}
