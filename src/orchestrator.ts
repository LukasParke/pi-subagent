import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig } from "./config.js";
import { ChildRunner, type GetPiCommand } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import type { RunMode, RunState, TaskResult, TaskSpec } from "./types.js";
import { WorktreeManager, type WorktreeHandle } from "./worktree.js";

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
  if (results.every((r) => r.state === "completed")) return "completed";
  if (results.some((r) => r.state === "completed")) return "partial";
  if (results.every((r) => r.state === "cancelled")) return "cancelled";
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
        const handle = await worktrees.create(spec.cwd || process.cwd(), spec.task.slice(0, 20), options.signal);
        handles[index] = handle;
        spec.cwd = handle.cwd;
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
        protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, validEvents: 0, parseErrors: 0 },
      }));
      return { mode: specs.length > 1 ? "parallel" : "single", results, state: "cancelled", summary: "Subagent run cancelled during setup" };
    }
    throw error;
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
    result.label = `task-${index + 1}`;
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
