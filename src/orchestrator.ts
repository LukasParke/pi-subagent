import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig } from "./config.js";
import { createGetPiCommand } from "./launch.js";
import type { ProcessLockManager } from "./process-lock.js";
import { ChildRunner, type GetPiCommand } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import type { RunMode, RunState, TaskResult, TaskSpec } from "./types.js";
import { addUsage } from "./usage.js";
import { WorktreeManager, type WorktreeHandle } from "./worktree.js";

export interface OrchestratorDeps {
  semaphore?: Semaphore;
  getPiCommand?: GetPiCommand;
  sessionDir?: string;
  worktrees?: WorktreeManager;
  killGraceMs?: number;
  locks?: ProcessLockManager;
  runId?: string;
  parentSessionKey?: string;
  onTaskProgress?: (index: number, partial: Partial<TaskResult>) => void;
  /** Exposes each task's live runner (for mid-run steering). Re-fires per retry attempt. */
  onRunnerCreated?: (index: number, runner: ChildRunner) => void;
  /** Wrap-up grace turns after budget breach (per-spec graceTurns overrides). */
  graceTurns?: number;
  /** Stall watchdog windows (0 disables). */
  stallAfterMs?: number;
  stallKillAfterMs?: number;
  /** Default extra attempts on transient failures (per-spec maxRetries overrides). */
  maxRetries?: number;
}

/**
 * Transient failures are infrastructure problems, not task problems: the same
 * spec is safe to retry without duplicating side effects because no meaningful
 * work happened (queued timeout) or the child died from environment causes
 * (stall, provider error, spawn error, unexpected signal).
 *
 * Never retried: real task failures (nonzero exit with complete protocol),
 * cancellations, budget stops, and running timeouts (work may be half-done).
 */
export function isTransientFailure(result: TaskResult): boolean {
  if (result.state === "timeout" && result.timeoutPhase === "queued") return true;
  if (result.stopReason === "stalled") return true;
  if (result.stopReason === "spawn_error") return true;
  // Provider/stream errors: stopReason "error" comes from provider-reported
  // failure or the fatal RPC path; both are retry-with-fallback candidates.
  if (result.state === "failed" && ["error", "protocol_error", "unexpected_signal"].includes(result.stopReason ?? "")) return true;
  return false;
}

export interface OrchestratedRun {
  mode: RunMode;
  results: TaskResult[];
  state: RunState;
  summary: string;
}

function aggregateState(results: TaskResult[]): RunState {
  if (results.every((r) => r.state === "completed")) return "completed";
  // Budget-stopped / truncated tasks ("partial") carry useful output.
  if (results.some((r) => r.state === "completed" || r.state === "partial")) return "partial";
  if (results.every((r) => r.state === "cancelled")) return "cancelled";
  if (results.every((r) => r.state === "timeout" || r.state === "cancelled")) return "timeout";
  if (results.some((r) => r.state === "timeout") && results.every((r) => ["timeout", "cancelled", "failed"].includes(r.state))) {
    return results.every((r) => r.state === "timeout") ? "timeout" : "failed";
  }
  return "failed";
}

function summarize(results: TaskResult[]): string {
  return results.map((r) => {
    const body = r.outputMode === "file-only"
      ? r.outputFile ? `Output written to ${r.outputFile}` : "No output artifact"
      : r.liveText || r.errorMessage || r.stderr || "(no output)";
    return `[${r.label}] ${r.state}\n${body}`;
  }).join("\n\n");
}

async function writeArtifact(spec: TaskSpec, result: TaskResult): Promise<void> {
  if (!spec.output) return;
  const text = result.liveText || result.errorMessage || result.stderr || "(no output)";
  await fs.mkdir(path.dirname(spec.output), { recursive: true });
  await fs.writeFile(spec.output, text, "utf8");
  result.outputFile = spec.output;
  result.outputMode = spec.outputMode;
}

export async function runTasks(
  specs: TaskSpec[],
  options: OrchestratorDeps & { signal?: AbortSignal } = {},
): Promise<OrchestratedRun> {
  const semaphore = options.semaphore ?? new Semaphore(defaultConfig.maxActiveProcesses, defaultConfig.maxQueuedTasks);
  const worktrees = options.worktrees ?? new WorktreeManager();
  const handles: Array<WorktreeHandle | undefined> = new Array(specs.length);
  const prepared: TaskSpec[] = [];

  try {
    for (let index = 0; index < specs.length; index++) {
      if (options.signal?.aborted) throw new Error("Subagent run cancelled before worktree setup");
      const spec = { ...specs[index]! };
      if (spec.isolation === "worktree") {
        const handle = await worktrees.create(spec.cwd || process.cwd(), spec.task.slice(0, 20), options.signal, {
          includeWip: spec.includeWip === true,
        });
        handles[index] = handle;
        spec.cwd = handle.cwd;
        // Announce the worktree immediately so live runs can shield it from GC sweeps.
        options.onTaskProgress?.(index, {
          worktree: { cwd: handle.cwd, branch: handle.branch, baseCommit: handle.baseCommit, changed: false },
        });
      }
      prepared.push(spec);
    }
  } catch (error) {
    // Setup failure: remove only unchanged worktrees. Preserve modified ones.
    for (const handle of handles.filter((h): h is WorktreeHandle => !!h)) {
      await worktrees.finalize(handle).catch(() => {});
    }
    if (options.signal?.aborted) {
      const results = specs.map<TaskResult>((spec, index) => ({
        label: `task-${index + 1}`,
        task: spec.task,
        state: "cancelled",
        exitCode: 1,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, contextTokens: 0, turns: 0 },
        stopReason: "cancelled",
        errorMessage: error instanceof Error ? error.message : String(error),
        thinking: spec.thinking,
        profile: spec.profile,
        canWrite: spec.canWrite,
        outputFile: spec.output,
        outputMode: spec.outputMode,
        protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, agentSettledSeen: false, validEvents: 0, parseErrors: 0 },
      }));
      return { mode: specs.length > 1 ? "parallel" : "single", results, state: "cancelled", summary: "Subagent run cancelled during setup" };
    }
    throw error;
  }

  const runOne = async (index: number): Promise<TaskResult> => {
    const spec = prepared[index]!;
    // Per-task durable id stays unique under a multi-task run by appending index.
    const taskRunId = options.runId
      ? (specs.length > 1 ? `${options.runId}:${index}` : options.runId)
      : undefined;

    // Retry with model fallback on transient failures. Attempt N uses the
    // N-1th fallback model (attempt 1 = primary). Usage accumulates across
    // attempts so the cost ledger reflects everything billed.
    const fallbacks = spec.fallbackModels ?? [];
    const maxRetries = spec.maxRetries ?? options.maxRetries ?? defaultConfig.maxRetries;
    // Providing fallback models implies wanting them all tried; otherwise
    // maxRetries bounds same-model retries.
    const maxAttempts = 1 + Math.max(maxRetries, fallbacks.length);
    const attemptedModels: string[] = [];
    let priorUsage: ReturnType<typeof addUsage> | undefined;
    let result!: TaskResult;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const model = attempt === 1 ? spec.model : (fallbacks[attempt - 2] ?? spec.model);
      if (model) attemptedModels.push(model);
      const attemptSpec: TaskSpec = { ...spec, model };
      const runner = new ChildRunner(
        semaphore,
        options.getPiCommand ?? createGetPiCommand(),
        options.sessionDir,
        (partial) => options.onTaskProgress?.(index, {
          ...partial,
          attempts: attempt > 1 ? attempt : undefined,
          usage: partial.usage && priorUsage ? addUsage(priorUsage, partial.usage) : partial.usage,
        }),
        options.killGraceMs,
        options.locks,
        taskRunId,
        options.parentSessionKey,
        undefined,
        { graceTurns: options.graceTurns, stallAfterMs: options.stallAfterMs, stallKillAfterMs: options.stallKillAfterMs },
      );
      options.onRunnerCreated?.(index, runner);
      result = await runner.run(attemptSpec, options.signal);
      if (priorUsage) result.usage = addUsage(priorUsage, result.usage);

      const canRetry = attempt < maxAttempts && !options.signal?.aborted && isTransientFailure(result);
      if (!canRetry) break;
      priorUsage = result.usage;
      const nextModel = fallbacks[attempt - 1];
      options.onTaskProgress?.(index, {
        state: "queued",
        attempts: attempt + 1,
        liveText: `Attempt ${attempt} ${result.stopReason ?? result.state}; retrying${nextModel ? ` on ${nextModel}` : ""}…`,
      });
    }

    if (attemptedModels.length > 1) {
      result.attempts = attemptedModels.length;
      result.attemptedModels = attemptedModels;
      if (result.errorMessage && (result.state === "failed" || result.state === "timeout")) {
        result.errorMessage += ` (after ${attemptedModels.length} attempts: ${attemptedModels.join(" → ")})`;
      }
    }
    result.index = index;
    result.label = spec.label || `task-${index + 1}`;
    result.outputMode = spec.outputMode;

    try {
      await writeArtifact(spec, result);
    } catch (error: any) {
      result.errorMessage = `${result.errorMessage ? `${result.errorMessage}; ` : ""}Artifact write failed: ${error?.message ?? error}`;
      if (result.state === "completed") result.state = "partial";
    }

    const handle = handles[index];
    if (handle) {
      try {
        // Finalize even on cancellation: it either preserves changed work or
        // removes an unchanged worktree, and both are quick local git calls.
        const final = await worktrees.finalize(handle);
        if (final.changed) {
          result.worktree = {
            cwd: final.cwd,
            branch: final.branch,
            baseCommit: final.baseCommit,
            changed: true,
            diffSummary: final.diffSummary,
          };
        }
      } catch (error: any) {
        result.errorMessage = `${result.errorMessage ? `${result.errorMessage}; ` : ""}Worktree finalization failed: ${error?.message ?? error}`;
        if (result.state === "completed") result.state = "partial";
      }
    }
    return result;
  };

  const results = await Promise.all(prepared.map((_, index) => runOne(index)));
  return {
    mode: results.length > 1 ? "parallel" : "single",
    results,
    state: aggregateState(results),
    summary: summarize(results),
  };
}
