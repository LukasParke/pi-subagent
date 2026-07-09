import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TaskResult, TaskSpec, RunMode, RunState } from "./types.js";
import { ChildRunner, type GetPiCommand } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { WorktreeManager, type WorktreeHandle } from "./worktree.js";
import { defaultConfig } from "./config.js";

export interface OrchestratorDeps {
  semaphore?: Semaphore;
  getPiCommand?: GetPiCommand;
  sessionDir?: string;
  worktrees?: WorktreeManager;
  onTaskProgress?: (index: number, partial: Partial<TaskResult>) => void;
}

export interface OrchestratedRun {
  mode: RunMode;
  results: TaskResult[];
  state: RunState;
  summary: string;
}

function aggregateState(results: TaskResult[]): RunState {
  if (results.length === 0) return "failed";
  const states = results.map((r) => r.state);
  if (states.every((s) => s === "completed")) return "completed";
  if (states.every((s) => s === "cancelled")) return "cancelled";
  if (states.some((s) => s === "completed") && states.some((s) => s !== "completed")) {
    return "partial";
  }
  if (states.some((s) => s === "cancelled")) return "cancelled";
  return "failed";
}

function summarize(results: TaskResult[]): string {
  return results
    .map((r, i) => {
      const head = `[${r.label || `task-${i + 1}`}] ${r.state}`;
      const body =
        r.liveText?.trim() ||
        r.errorMessage ||
        r.stderr?.trim() ||
        (r.outputFile ? `(output saved to ${r.outputFile})` : "(no output)");
      return `${head}\n${body}`;
    })
    .join("\n\n");
}

async function maybeWriteOutput(spec: TaskSpec, result: TaskResult): Promise<void> {
  if (!spec.output) return;
  const text =
    result.liveText ||
    result.errorMessage ||
    result.stderr ||
    "(no output)";
  await fs.mkdir(path.dirname(spec.output), { recursive: true });
  await fs.writeFile(spec.output, text, "utf8");
  result.outputFile = spec.output;
  if (spec.outputMode === "file-only") {
    result.liveText = `Output written to ${spec.output}`;
  }
}

/**
 * Run one or many tasks under a shared semaphore and optional worktree isolation.
 */
export async function runTasks(
  specs: TaskSpec[],
  options: OrchestratorDeps & { signal?: AbortSignal } = {},
): Promise<OrchestratedRun> {
  const semaphore =
    options.semaphore ??
    new Semaphore(defaultConfig.maxActiveProcesses, defaultConfig.maxQueuedTasks);
  const worktrees = options.worktrees ?? new WorktreeManager();
  const mode: RunMode = specs.length > 1 ? "parallel" : "single";

  const handles: Array<WorktreeHandle | undefined> = new Array(specs.length);

  const prepared: TaskSpec[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = { ...specs[i]! };
    if (spec.isolation === "worktree") {
      const handle = await worktrees.create(spec.cwd || process.cwd(), spec.task.slice(0, 20));
      handles[i] = handle;
      spec.cwd = handle.cwd;
    }
    prepared.push(spec);
  }

  const runOne = async (index: number): Promise<TaskResult> => {
    const spec = prepared[index]!;
    const runner = new ChildRunner(
      semaphore,
      options.getPiCommand,
      options.sessionDir,
      (partial) => options.onTaskProgress?.(index, partial),
    );
    const result = await runner.run(spec, options.signal);
    result.index = index;
    result.label = result.label || `task-${index + 1}`;
    result.task = spec.task;
    try {
      await maybeWriteOutput(spec, result);
    } catch (err: any) {
      result.errorMessage = (result.errorMessage ? result.errorMessage + "; " : "") +
        `Failed to write output: ${err?.message ?? err}`;
      if (result.state === "completed") result.state = "partial";
    }

    const handle = handles[index];
    if (handle) {
      try {
        const finalHandle = await worktrees.finalize(handle);
        if (finalHandle.changed) {
          result.liveText =
            `${result.liveText ?? ""}\n\n[worktree preserved] branch=${finalHandle.branch} cwd=${finalHandle.cwd}` +
            (finalHandle.diffSummary ? `\n${finalHandle.diffSummary}` : "");
        }
      } catch (err: any) {
        result.errorMessage =
          (result.errorMessage ? result.errorMessage + "; " : "") +
          `Worktree finalize failed: ${err?.message ?? err}`;
      }
    }
    return result;
  };

  // Launch all; semaphore serializes process starts beyond maxActive.
  const results = await Promise.all(prepared.map((_, i) => runOne(i)));
  const state = aggregateState(results);
  return {
    mode,
    results,
    state,
    summary: summarize(results),
  };
}
