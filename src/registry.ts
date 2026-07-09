import { randomUUID } from 'node:crypto';
import type { RunMode, RunState, TaskSpec, TaskResult, RunSnapshot, UsageStats } from './types.js';
import type { Message } from '@earendil-works/pi-ai';
import type { SubagentConfig } from './config.js';
import type { PersistenceAdapter } from './persistence.js';
import { PersistenceLayer, type PersistenceEvent } from './persistence.js';

export interface LiveRun {
  id: string;
  sessionKey: string;
  mode: RunMode;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  taskPreviews: string[];
  taskSpecs: TaskSpec[];
  results: TaskResult[]; // full live only
  summary?: string;
  delivered: boolean;
  promise: Promise<any>;
  controller: AbortController;
  childSessionIds: Set<string>;
  resumeLock?: string; // child session id holding direct resume
  progressThrottle?: NodeJS.Timeout;
  lastCheckpoint?: number;
}

export interface RunLookupResult {
  status: 'found' | 'not-found' | 'ambiguous';
  run?: LiveRun | RunSnapshot;
  matches?: string[];
}

export interface SessionRuntime {
  sessionKey: string;
  runs: Map<string, LiveRun>;
  snapshots: Map<string, RunSnapshot>;
  activeResumes: Map<string, string>; // childSessionId -> runId (for lock)
}

/** Session-scoped run registry and lifecycle. Full data for live, snapshot for completed. Callbacks verify ownership. Never persist to new session. Shutdown with grace. */
export class SessionScopedRunRegistry {
  private runtimes = new Map<string, SessionRuntime>();
  private globalActiveControllers = new Set<AbortController>();
  private persistence: PersistenceLayer;
  private retentionPlanner: (refs: Set<string>) => { keep: string[]; candidates: string[] };

  constructor(
    private config: SubagentConfig,
    persistenceAdapter: PersistenceAdapter,
  ) {
    this.persistence = new PersistenceLayer(persistenceAdapter, config);
    this.retentionPlanner = (refs) => this.persistence.planRetention(refs);
  }

  /** Get or create runtime keyed by stable parent sessionKey. */
  private getRuntime(sessionKey: string): SessionRuntime {
    if (!this.runtimes.has(sessionKey)) {
      const runtime: SessionRuntime = {
        sessionKey,
        runs: new Map(),
        snapshots: new Map(),
        activeResumes: new Map(),
      };
      // Restore older state from persistence on first access
      const restored = this.persistence.rebuild(sessionKey);
      for (const [id, snap] of restored) {
        runtime.snapshots.set(id, snap);
      }
      this.runtimes.set(sessionKey, runtime);
    }
    return this.runtimes.get(sessionKey)!;
  }

  private verifyOwnership(runtime: SessionRuntime, runId: string, callerSessionKey?: string): LiveRun | null {
    const live = runtime.runs.get(runId);
    if (!live) return null;
    if (callerSessionKey && live.sessionKey !== callerSessionKey) return null;
    return live;
  }

  /** Full UUID internally. Unique prefix resolution (discriminated found/not-found/ambiguous). */
  lookup(idOrPrefix: string, sessionKey?: string): RunLookupResult {
    if (!idOrPrefix) return { status: 'not-found' };

    let candidates: Array<LiveRun | RunSnapshot> = [];

    for (const rt of this.runtimes.values()) {
      if (sessionKey && rt.sessionKey !== sessionKey) continue;

      const live = rt.runs.get(idOrPrefix);
      if (live) candidates.push(live);

      const snap = rt.snapshots.get(idOrPrefix);
      if (snap) candidates.push(snap);

      for (const [k, v] of rt.runs) {
        if (k.startsWith(idOrPrefix) && k !== idOrPrefix) candidates.push(v);
      }
      for (const [k, v] of rt.snapshots) {
        if (k.startsWith(idOrPrefix) && k !== idOrPrefix) candidates.push(v);
      }
    }

    const uniqueIds = new Set(candidates.map((c) => c.id));
    if (uniqueIds.size === 0) return { status: 'not-found' };
    if (uniqueIds.size > 1) {
      return {
        status: 'ambiguous',
        matches: Array.from(uniqueIds).slice(0, 5),
      };
    }

    const exactId = Array.from(uniqueIds)[0]!;
    // Re-find the run with full key
    for (const rt of this.runtimes.values()) {
      const live = rt.runs.get(exactId);
      if (live && (!sessionKey || live.sessionKey === sessionKey)) {
        return { status: 'found', run: live };
      }
      const snap = rt.snapshots.get(exactId);
      if (snap && (!sessionKey || snap.sessionKey === sessionKey)) {
        return { status: 'found', run: snap };
      }
    }

    return { status: 'not-found' };
  }

  /** Start/register a run. Registers with runtime, persists start, verifies before callbacks. */
  start(
    sessionKey: string,
    mode: RunMode,
    specs: TaskSpec[],
    controller: AbortController,
    promise: Promise<any>,
    labels: string[] = [],
  ): string {
    const id = randomUUID().replace(/-/g, '').slice(0, 12); // stable short hex for lookup
    const runtime = this.getRuntime(sessionKey);

    const taskPreviews = specs.map((s, i) => (labels?.[i] || `task-${i + 1}`) + ': ' + s.task.slice(0, 80));

    const liveRun: LiveRun = {
      id,
      sessionKey,
      mode,
      state: 'running',
      startedAt: Date.now(),
      taskPreviews,
      taskSpecs: [...specs],
      results: specs.map((spec, idx) => ({
        label: labels?.[idx] || `task-${idx + 1}`,
        task: spec.task,
        state: 'running' as RunState,
        exitCode: null,
        messages: [],
        stderr: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        protocol: {
          headerSeen: false,
          assistantEndSeen: false,
          agentEndSeen: false,
          validEvents: 0,
          parseErrors: 0,
        },
      })),
      summary: undefined,
      delivered: false,
      promise,
      controller,
      childSessionIds: new Set(),
      lastCheckpoint: Date.now(),
    };

    runtime.runs.set(id, liveRun);
    this.globalActiveControllers.add(controller);

    // Persist start (minimal)
    this.persistence.persist(id, sessionKey, 'start', {
      mode,
      startedAt: liveRun.startedAt,
      taskPreviews: taskPreviews.map((p) => p.split(': ')[1] || p),
    });

    return id;
  }

  /** Checkpoint: child-session-id, throttled progress/turn. Callbacks verify ownership/currentness before UI/persistence. */
  checkpoint(
    id: string,
    sessionKey: string,
    updates: Partial<LiveRun> & { childSessionId?: string; progress?: string; turn?: number; resultIndex?: number; resultUpdate?: Partial<TaskResult> },
  ): boolean {
    const runtime = this.getRuntime(sessionKey);
    const run = this.verifyOwnership(runtime, id, sessionKey);
    if (!run) return false;

    const now = Date.now();
    if (updates.childSessionId) {
      run.childSessionIds.add(updates.childSessionId);
      if (!run.resumeLock) {
        run.resumeLock = updates.childSessionId; // acquire direct resume lock
      }
    }

    if (updates.resultIndex !== undefined && updates.resultUpdate) {
      const idx = updates.resultIndex;
      if (run.results[idx]) {
        Object.assign(run.results[idx], updates.resultUpdate);
        if (updates.resultUpdate.state && ['completed', 'partial', 'failed', 'cancelled'].includes(updates.resultUpdate.state)) {
          run.results[idx].endedAt = Date.now();
        }
      }
    }

    // Throttled checkpoint (progress/turn)
    const shouldPersist = !run.lastCheckpoint || now - run.lastCheckpoint > 250;
    if (shouldPersist && (updates.progress || updates.turn !== undefined)) {
      run.lastCheckpoint = now;
      this.persistence.persist(id, sessionKey, 'checkpoint', {
        childSessionId: updates.childSessionId,
        progress: updates.progress,
        turn: updates.turn,
        state: run.state,
      });
    }

    // Update live fields
    if (updates.state) run.state = updates.state;
    if (updates.summary) run.summary = updates.summary;
    if (updates.endedAt) run.endedAt = updates.endedAt;

    return true;
  }

  /** Terminal: complete/partial/fail/cancel/lost. Convert to snapshot, cap in-memory, persist. */
  complete(id: string, sessionKey: string, finalState: RunState, summary?: string, finalResults?: TaskResult[]): boolean {
    const runtime = this.getRuntime(sessionKey);
    const run = runtime.runs.get(id);
    if (!run || run.sessionKey !== sessionKey) return false;

    run.state = finalState;
    run.endedAt = Date.now();
    if (summary) run.summary = summary;
    if (finalResults) {
      run.results = finalResults;
    }

    // Convert to lightweight snapshot, cap history
    const snapshot: RunSnapshot = {
      schemaVersion: 1,
      id: run.id,
      sessionKey: run.sessionKey,
      mode: run.mode,
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      taskPreviews: run.taskPreviews,
      summary: run.summary,
      delivered: run.delivered,
      results: run.results.map((r) => ({
        label: r.label,
        task: r.task.slice(0, 200),
        state: r.state,
        exitCode: r.exitCode,
        stopReason: r.stopReason,
        errorMessage: r.errorMessage?.slice(0, 500),
        usage: r.usage,
        model: r.model,
        outputFile: r.outputFile,
        sessionId: r.sessionId,
        finalOutput: this.extractFinalOutput(r.messages)?.slice(0, 4096),
      })),
    };

    runtime.snapshots.set(id, snapshot);

    // Persist terminal
    this.persistence.persist(
      id,
      sessionKey,
      'terminal',
      {
        state: finalState,
        endedAt: run.endedAt,
        summary,
        results: snapshot.results,
      },
      true,
    );

    // Cap in-memory: keep only recent
    if (runtime.snapshots.size > this.config.maxCompletedInMemory) {
      const oldest = Array.from(runtime.snapshots.values()).sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) runtime.snapshots.delete(oldest.id);
    }

    runtime.runs.delete(id);
    this.globalActiveControllers.delete(run.controller);

    return true;
  }

  /** Mark delivered or dismissed (for output/UI). */
  markDelivered(id: string, sessionKey: string): boolean {
    const runtime = this.getRuntime(sessionKey);
    const run = this.verifyOwnership(runtime, id, sessionKey);
    if (!run) {
      const snap = runtime.snapshots.get(id);
      if (snap && snap.sessionKey === sessionKey) {
        snap.delivered = true;
        this.persistence.markDelivered(id, sessionKey);
        return true;
      }
      return false;
    }
    run.delivered = true;
    this.persistence.markDelivered(id, sessionKey);
    return true;
  }

  markDismissed(id: string, sessionKey: string): boolean {
    return this.markDelivered(id, sessionKey); // similar
  }

  /** Per-child-session resume lock: direct resume serialized or rejected. Fork separate. Test for concurrent. */
  acquireResumeLock(childSessionId: string, runId: string, sessionKey: string, isFork = false): boolean {
    const runtime = this.getRuntime(sessionKey);
    if (!isFork) {
      if (runtime.activeResumes.has(childSessionId)) {
        const existingRun = runtime.activeResumes.get(childSessionId);
        if (existingRun !== runId) return false; // already held by another
      }
      runtime.activeResumes.set(childSessionId, runId);
    }
    const run = runtime.runs.get(runId);
    if (run) run.resumeLock = childSessionId;
    return true;
  }

  releaseResumeLock(childSessionId: string, sessionKey: string): void {
    const runtime = this.getRuntime(sessionKey);
    runtime.activeResumes.delete(childSessionId);
    for (const run of runtime.runs.values()) {
      if (run.resumeLock === childSessionId) run.resumeLock = undefined;
    }
  }

  /** Shutdown: abort all controllers, await promises with bounded grace (config based), persist final, clear. Never persist into new session. */
  async shutdown(sessionKey?: string, graceMs = 5000): Promise<void> {
    const runtimesToShutdown = sessionKey
      ? [this.runtimes.get(sessionKey)].filter((r): r is SessionRuntime => !!r)
      : Array.from(this.runtimes.values());

    const promises: Promise<any>[] = [];
    for (const rt of runtimesToShutdown) {
      for (const run of rt.runs.values()) {
        if (run.state === 'running') {
          run.controller.abort();
          run.state = 'cancelled';
          promises.push(run.promise.catch(() => {}));
          this.persistence.persist(run.id, rt.sessionKey, 'terminal', { state: 'cancelled', endedAt: Date.now() });
        }
      }
      // Clear
      rt.runs.clear();
    }

    this.globalActiveControllers.forEach((c) => c.abort());
    this.globalActiveControllers.clear();

    // Bounded grace
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('grace timeout')), graceMs));
    await Promise.race([Promise.allSettled(promises), timeout]).catch(() => {});

    // Persist final snapshots (already done in complete)
    for (const rt of runtimesToShutdown) {
      if (rt) {
        this.persistence.rebuild(rt.sessionKey);
      }
    }

    if (!sessionKey) this.runtimes.clear();
  }

  getLiveRuns(sessionKey: string): LiveRun[] {
    return Array.from(this.getRuntime(sessionKey).runs.values());
  }

  getSessionRuntime(sessionKey: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionKey);
  }

  private extractFinalOutput(messages: Message[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && typeof (part as any).text === 'string') {
            return (part as any).text;
          }
        }
      }
    }
    return undefined;
  }

  /** Session retention planner - no destructive default */
  planSessionRetention(referencedSessionIds: Set<string> = new Set()): { keep: string[]; candidates: string[] } {
    return this.retentionPlanner(referencedSessionIds);
  }
}
