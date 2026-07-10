import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentConfig } from "./config.js";
import type { PersistenceAdapter, PersistedResult } from "./persistence.js";
import { PersistenceLayer } from "./persistence.js";
import type { RunMode, RunSnapshot, RunState, TaskResult, TaskSpec } from "./types.js";
import { emptyUsage } from "./types.js";

export interface LiveRun {
  id: string;
  sessionKey: string;
  mode: RunMode;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  taskPreviews: string[];
  taskSpecs: TaskSpec[];
  results: TaskResult[];
  summary?: string;
  delivered: boolean;
  promise: Promise<unknown>;
  controller: AbortController;
  childSessionIds: Set<string>;
  lastProgressCheckpoint: number;
}

export interface RunLookupResult {
  status: "found" | "not-found" | "ambiguous";
  run?: LiveRun | RunSnapshot;
  matches?: string[];
}

export interface SessionRuntime {
  sessionKey: string;
  runs: Map<string, LiveRun>;
  snapshots: Map<string, RunSnapshot>;
  activeResumes: Map<string, string>;
  shuttingDown: boolean;
}

export type RegistryEvent =
  | { type: "changed"; sessionKey: string; runId: string }
  | { type: "terminal"; sessionKey: string; runId: string; state: RunState };

const terminalStates = new Set<RunState>(["completed", "partial", "failed", "cancelled", "lost"]);

function finalText(messages: Message[], fallback?: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (text) return text;
  }
  return fallback;
}

function transcript(messages: Message[]): string | undefined {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as any[]) {
        if (part?.type === "text" && part.text) lines.push(part.text);
        if (part?.type === "toolCall") lines.push(`→ ${part.name} ${JSON.stringify(part.arguments ?? {})}`);
      }
    } else if (message.role === "toolResult") {
      const text = Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("")
        : "";
      lines.push(`← ${message.toolName}${message.isError ? " [error]" : ""} ${text}`);
    }
  }
  const value = lines.join("\n");
  return value || undefined;
}

function utf8Prefix(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return undefined;
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function toPersistedResult(result: TaskResult): PersistedResult {
  return {
    label: result.label,
    task: result.task.slice(0, 1_000),
    state: result.state,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    usage: result.usage,
    model: result.model,
    thinking: result.thinking,
    profile: result.profile,
    canWrite: result.canWrite,
    outputFile: result.outputFile,
    outputMode: result.outputMode,
    sessionId: result.sessionId,
    finalOutput: utf8Prefix(finalText(result.messages, result.liveText), 16_384),
    transcript: utf8Prefix(transcript(result.messages), 32_768),
    worktree: result.worktree,
  };
}

/** Session-owned live state plus immutable, bounded terminal snapshots. */
export class SessionScopedRunRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly persistence: PersistenceLayer;
  private readonly listeners = new Set<(event: RegistryEvent) => void>();

  constructor(
    private readonly config: SubagentConfig,
    persistenceAdapter: PersistenceAdapter,
  ) {
    this.persistence = new PersistenceLayer(persistenceAdapter, config);
  }

  allocateRunId(): string {
    return randomUUID();
  }

  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private getOrCreateRuntime(sessionKey: string): SessionRuntime {
    let runtime = this.runtimes.get(sessionKey);
    if (!runtime) {
      runtime = {
        sessionKey,
        runs: new Map(),
        snapshots: this.persistence.rebuild(sessionKey),
        activeResumes: new Map(),
        shuttingDown: false,
      };
      this.runtimes.set(sessionKey, runtime);
    }
    return runtime;
  }

  getSessionRuntime(sessionKey: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionKey);
  }

  getLiveRuns(sessionKey: string): LiveRun[] {
    return [...this.getOrCreateRuntime(sessionKey).runs.values()];
  }

  getSnapshots(sessionKey: string): RunSnapshot[] {
    return [...this.getOrCreateRuntime(sessionKey).snapshots.values()];
  }

  /** Rebuild terminal history after active-branch navigation. Live runs stay session-owned. */
  refreshSnapshots(sessionKey: string): void {
    const runtime = this.getOrCreateRuntime(sessionKey);
    runtime.snapshots = this.persistence.rebuild(sessionKey);
    this.capSnapshots(runtime);
    this.emit({ type: "changed", sessionKey, runId: "branch" });
  }

  lookup(idOrPrefix: string, sessionKey: string): RunLookupResult {
    if (!idOrPrefix) return { status: "not-found" };
    const runtime = this.getOrCreateRuntime(sessionKey);
    const exact = runtime.runs.get(idOrPrefix) ?? runtime.snapshots.get(idOrPrefix);
    if (exact) return { status: "found", run: exact };

    const matches = new Map<string, LiveRun | RunSnapshot>();
    for (const [id, run] of runtime.runs) if (id.startsWith(idOrPrefix)) matches.set(id, run);
    for (const [id, run] of runtime.snapshots) if (id.startsWith(idOrPrefix)) matches.set(id, run);
    if (matches.size === 0) return { status: "not-found" };
    if (matches.size > 1) return { status: "ambiguous", matches: [...matches.keys()].sort() };
    return { status: "found", run: [...matches.values()][0] };
  }

  start(
    sessionKey: string,
    mode: RunMode,
    specs: TaskSpec[],
    controller: AbortController,
    promise: Promise<unknown>,
    labels: string[] = [],
    id = this.allocateRunId(),
  ): string {
    const runtime = this.getOrCreateRuntime(sessionKey);
    if (runtime.shuttingDown) throw new Error("Cannot start a subagent while the parent session is shutting down");
    if (runtime.runs.has(id) || runtime.snapshots.has(id)) throw new Error(`Duplicate run id ${id}`);

    const startedAt = Date.now();
    const taskPreviews = specs.map((spec, i) => `${labels[i] || `task-${i + 1}`}: ${spec.task.slice(0, 120)}`);
    const results: TaskResult[] = specs.map((spec, i) => ({
      label: labels[i] || `task-${i + 1}`,
      task: spec.task,
      state: "queued",
      exitCode: null,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      outputFile: spec.output,
      outputMode: spec.outputMode,
      thinking: spec.thinking,
      profile: spec.profile,
      canWrite: spec.canWrite,
      protocol: {
        headerSeen: false,
        assistantEndSeen: false,
        agentEndSeen: false,
        validEvents: 0,
        parseErrors: 0,
      },
    }));

    runtime.runs.set(id, {
      id,
      sessionKey,
      mode,
      state: "queued",
      startedAt,
      taskPreviews,
      taskSpecs: [...specs],
      results,
      delivered: false,
      promise,
      controller,
      childSessionIds: new Set(),
      lastProgressCheckpoint: 0,
    });
    this.persistence.persist(id, sessionKey, "start", {
      mode,
      state: "queued",
      startedAt,
      taskPreviews,
      results: results.map(toPersistedResult),
    });
    this.emit({ type: "changed", sessionKey, runId: id });
    return id;
  }

  checkpoint(
    id: string,
    sessionKey: string,
    updates: {
      childSessionId?: string;
      progress?: string;
      turn?: number;
      resultIndex?: number;
      resultUpdate?: Partial<TaskResult>;
      state?: RunState;
    },
  ): boolean {
    const runtime = this.runtimes.get(sessionKey);
    const run = runtime?.runs.get(id);
    if (!runtime || !run || run.sessionKey !== sessionKey || runtime.shuttingDown) return false;

    const index = updates.resultIndex ?? 0;
    const result = run.results[index];
    const previousTurns = result?.usage.turns ?? 0;
    const previousCost = result?.usage.cost ?? 0;
    if (result && updates.resultUpdate) Object.assign(result, updates.resultUpdate);
    const usageAdvanced = !!result && (result.usage.turns > previousTurns || result.usage.cost > previousCost);
    if (updates.state) run.state = updates.state;
    else if (run.state === "queued") run.state = "running";

    const childSessionId = updates.childSessionId ?? updates.resultUpdate?.sessionId;
    if (childSessionId) {
      const isNew = !run.childSessionIds.has(childSessionId);
      run.childSessionIds.add(childSessionId);
      if (result) result.sessionId = childSessionId;
      // Crash recovery requirement: session ids are never throttled.
      if (isNew) {
        this.persistence.persist(id, sessionKey, "checkpoint", {
          state: run.state,
          resultIndex: index,
          childSessionId,
          results: run.results.map(toPersistedResult),
        });
      }
    }

    const now = Date.now();
    if (usageAdvanced || ((updates.progress || updates.turn !== undefined) && now - run.lastProgressCheckpoint >= 500)) {
      run.lastProgressCheckpoint = now;
      this.persistence.persist(id, sessionKey, "checkpoint", {
        state: run.state,
        resultIndex: index,
        progress: updates.progress,
        turn: updates.turn,
        results: run.results.map(toPersistedResult),
      });
    }
    this.emit({ type: "changed", sessionKey, runId: id });
    return true;
  }

  complete(
    id: string,
    sessionKey: string,
    finalState: RunState,
    summary?: string,
    finalResults?: TaskResult[],
  ): boolean {
    const runtime = this.runtimes.get(sessionKey);
    const run = runtime?.runs.get(id);
    if (!runtime || !run || run.sessionKey !== sessionKey) return false;

    const endedAt = Date.now();
    const results = finalResults ?? run.results;
    const snapshot: RunSnapshot = {
      schemaVersion: 1,
      id,
      sessionKey,
      mode: run.mode,
      state: terminalStates.has(finalState) ? finalState : "failed",
      startedAt: run.startedAt,
      endedAt,
      taskPreviews: run.taskPreviews,
      summary,
      delivered: run.delivered,
      results: results.map(toPersistedResult),
    };
    runtime.snapshots.set(id, snapshot);
    runtime.runs.delete(id);
    this.releaseLocksForRun(runtime, id);
    this.persistence.persist(id, sessionKey, "terminal", {
      mode: snapshot.mode,
      state: snapshot.state,
      startedAt: snapshot.startedAt,
      endedAt,
      taskPreviews: snapshot.taskPreviews,
      summary,
      delivered: snapshot.delivered,
      results: snapshot.results,
    });
    this.capSnapshots(runtime);
    this.emit({ type: "terminal", sessionKey, runId: id, state: snapshot.state });
    return true;
  }

  /** Returns false when this result was already delivered. */
  markDelivered(id: string, sessionKey: string): boolean {
    const runtime = this.getOrCreateRuntime(sessionKey);
    const run = runtime.runs.get(id) ?? runtime.snapshots.get(id);
    if (!run || run.delivered) return false;
    run.delivered = true;
    this.persistence.markDelivered(id, sessionKey);
    this.emit({ type: "changed", sessionKey, runId: id });
    return true;
  }

  markDismissed(id: string, sessionKey: string): boolean {
    return this.markDelivered(id, sessionKey);
  }

  acquireResumeLocks(childSessionIds: string[], runId: string, sessionKey: string): {
    ok: boolean;
    conflict?: { sessionId: string; runId: string };
  } {
    const runtime = this.getOrCreateRuntime(sessionKey);
    const unique = [...new Set(childSessionIds)];
    for (const sessionId of unique) {
      const holder = runtime.activeResumes.get(sessionId);
      if (holder && holder !== runId) return { ok: false, conflict: { sessionId, runId: holder } };
    }
    for (const sessionId of unique) runtime.activeResumes.set(sessionId, runId);
    return { ok: true };
  }

  acquireResumeLock(childSessionId: string, runId: string, sessionKey: string, isFork = false): boolean {
    if (isFork) return true;
    return this.acquireResumeLocks([childSessionId], runId, sessionKey).ok;
  }

  releaseResumeLock(childSessionId: string, sessionKey: string, runId?: string): void {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime) return;
    if (!runId || runtime.activeResumes.get(childSessionId) === runId) runtime.activeResumes.delete(childSessionId);
  }

  private releaseLocksForRun(runtime: SessionRuntime, runId: string): void {
    for (const [sessionId, holder] of runtime.activeResumes) {
      if (holder === runId) runtime.activeResumes.delete(sessionId);
    }
  }

  async shutdown(sessionKey: string, graceMs = 8_000): Promise<void> {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime) return;
    runtime.shuttingDown = true;
    const live = [...runtime.runs.values()];
    for (const run of live) run.controller.abort();

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(live.map((run) => run.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    // Any orchestration promise that did not call complete is snapshotted as cancelled.
    for (const run of [...runtime.runs.values()]) {
      this.complete(run.id, sessionKey, "cancelled", "Cancelled when the parent session shut down", run.results);
    }
    runtime.activeResumes.clear();
    runtime.shuttingDown = false;
  }

  planSessionRetention(referencedSessionIds = new Set<string>()): { keep: string[]; candidates: string[] } {
    return this.persistence.planRetention(referencedSessionIds);
  }

  private capSnapshots(runtime: SessionRuntime): void {
    while (runtime.snapshots.size > this.config.maxCompletedInMemory) {
      const oldest = [...runtime.snapshots.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldest) break;
      runtime.snapshots.delete(oldest.id);
    }
  }
}
