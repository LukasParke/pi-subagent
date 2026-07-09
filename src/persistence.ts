import type { RunSnapshot, RunState, RunMode } from './types.js';
import type { SubagentConfig } from './config.js';

export interface PersistenceAdapter {
  /** Usable by Pi appendEntry; no extension API imports needed here. */
  appendEntry(type: string, payload: unknown): void;
  /** Returns all session entries for rebuild (e.g. from ctx.sessionManager.getEntries()). */
  getEntries(): Array<{ type?: string; customType?: string; data?: unknown; timestamp?: number }>;
  getActiveBranch?(): string | undefined;
}

export interface PersistenceEvent {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  timestamp: number;
  type: 'start' | 'checkpoint' | 'terminal' | 'delivered' | 'dismissed';
  branch?: string;
  data: {
    mode?: RunMode;
    state?: RunState;
    startedAt?: number;
    endedAt?: number;
    taskPreviews?: string[];
    summary?: string;
    delivered?: boolean;
    results?: Array<{
      label: string;
      task: string;
      state: RunState;
      exitCode: number | null;
      stopReason?: string;
      errorMessage?: string;
      usage: any;
      model?: string;
      outputFile?: string;
      sessionId?: string;
      finalOutput?: string;
    }>;
    childSessionId?: string;
    progress?: string;
    turn?: number;
    [key: string]: unknown;
  };
}

/** Branch-aware persistence. Rebuilds latest state per-id from active branch only. Latest schema v1 wins. Running records restored as 'lost'. Malformed skipped. */
export class PersistenceLayer {
  constructor(
    private adapter: PersistenceAdapter,
    private config: SubagentConfig,
  ) {}

  private getCurrentBranch(): string | undefined {
    return this.adapter.getActiveBranch?.();
  }

  /** Persist a start, checkpoint (child-session-id, throttled progress/turn), or terminal state. */
  persist(
    id: string,
    sessionKey: string,
    type: PersistenceEvent['type'],
    data: PersistenceEvent['data'],
    isTerminal = false,
  ): void {
    if (!sessionKey) return; // Never persist into a new/unknown session.

    const event: PersistenceEvent = {
      schemaVersion: 1,
      id,
      sessionKey,
      timestamp: Date.now(),
      type,
      branch: this.getCurrentBranch(),
      data: {
        ...data,
        // Throttle implicit by caller; terminal always persisted
      },
    };

    this.adapter.appendEntry('subagent-run-v1', event);
  }

  /** Rebuild runtime state from entries. Only active branch, latest per id, validate, running->lost. */
  rebuild(sessionKey: string): Map<string, RunSnapshot> {
    const entries = this.adapter
      .getEntries()
      .filter((e: any) => {
        const payload = (e.data || e) as any;
        const effectivePayload = payload || e;
        return (
          (e.type === 'subagent-run-v1' || e.customType === 'subagent-run-v1' || effectivePayload?.type === 'subagent-run-v1' || effectivePayload?.schemaVersion === 1) &&
          effectivePayload?.schemaVersion === 1 &&
          effectivePayload?.sessionKey === sessionKey
        );
      });

    const byId = new Map<string, PersistenceEvent[]>();

    for (const entry of entries) {
      const payload = (entry.data || entry) as any;
      const ev: PersistenceEvent = {
        schemaVersion: 1,
        id: payload.id,
        sessionKey: payload.sessionKey || sessionKey,
        timestamp: payload.timestamp || Date.now(),
        type: (payload.type || 'terminal') as any,
        branch: payload.branch,
        data: payload.data || payload,
      };
      if (!ev.id || !ev.sessionKey) continue; // malformed

      const branch = ev.branch || this.getCurrentBranch();
      if (this.getCurrentBranch() && branch !== this.getCurrentBranch()) continue; // branch-aware: active only

      if (!byId.has(ev.id)) byId.set(ev.id, []);
      byId.get(ev.id)!.push(ev);
    }

    const snapshots = new Map<string, RunSnapshot>();

    for (const [id, events] of byId.entries()) {
      // Latest wins
      events.sort((a, b) => b.timestamp - a.timestamp);
      const latest = events[0]!;

      let snapshot = this.snapshotFromEvent(latest, id, sessionKey);

      // Validate
      if (!this.isValidSnapshot(snapshot)) {
        continue; // skip malformed
      }

      // Running records restore as lost (process died with parent)
      if (snapshot.state === 'running' || snapshot.state === 'queued') {
        snapshot = {
          ...snapshot,
          state: 'lost' as RunState,
          endedAt: Date.now(),
          summary: snapshot.summary || 'Run was lost across restart (child process terminated).',
        };
      }

      snapshots.set(id, snapshot);
    }

    return snapshots;
  }

  private snapshotFromEvent(ev: PersistenceEvent, id: string, sessionKey: string): RunSnapshot {
    const d = ev.data;
    return {
      schemaVersion: 1,
      id,
      sessionKey,
      mode: (d.mode as RunMode) || 'single',
      state: (d.state as RunState) || 'completed',
      startedAt: d.startedAt || ev.timestamp,
      endedAt: d.endedAt,
      taskPreviews: d.taskPreviews || [],
      summary: d.summary,
      delivered: d.delivered || false,
      results: (d.results || []).map((r: any) => ({
        label: r.label || '',
        task: r.task || '',
        state: r.state || 'completed',
        exitCode: r.exitCode ?? null,
        stopReason: r.stopReason,
        errorMessage: r.errorMessage,
        usage: r.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: r.model,
        outputFile: r.outputFile,
        sessionId: r.sessionId,
        finalOutput: r.finalOutput?.slice(0, 4096),
      })),
    };
  }

  private isValidSnapshot(s: RunSnapshot): boolean {
    return (
      typeof s.id === 'string' &&
      typeof s.sessionKey === 'string' &&
      ['single', 'parallel'].includes(s.mode) &&
      s.taskPreviews.every((p) => typeof p === 'string')
    );
  }

  /** Mark delivered (compact in-memory history). */
  markDelivered(id: string, sessionKey: string): void {
    this.persist(id, sessionKey, 'delivered', { delivered: true });
  }

  /** Cleanup planner: no destructive default. Only if retention configured, emit referenced IDs and candidates. */
  planRetention(referencedSessionIds: Set<string>): { keep: string[]; candidates: string[] } {
    if (typeof this.config.sessionRetentionDays !== 'number' || this.config.sessionRetentionDays <= 0) {
      return { keep: [], candidates: [] }; // no destructive 7-day default
    }

    // In real impl would scan FS or index, but here just placeholder per spec: produce candidates only when configured.
    // Do not perform FS deletion.
    return {
      keep: Array.from(referencedSessionIds),
      candidates: [], // would compute stale non-referenced here
    };
  }
}
