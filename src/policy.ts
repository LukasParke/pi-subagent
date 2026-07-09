import * as path from "node:path";
import { defaultConfig } from "./config.js";
import type { TaskProfile, TaskSpec, OutputMode } from "./types.js";
import type { ParallelTaskInput, SubagentParams } from "./schema.js";

export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";

/** Tools always banned from explore/review profiles. */
export const WRITE_TOOLS = new Set(["bash", "edit", "write"]);

/** Read-only defaults for exploration/review. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface ParentContext {
  cwd: string;
  model?: string;
  thinking?: TaskSpec["thinking"];
  availableTools: string[];
  activeTools?: string[];
  depth?: number;
}

export interface ResolvedTask extends TaskSpec {
  label: string;
  canWrite: boolean;
  effectiveTools: string[];
  worktreeBranch?: string;
  resolutionNotes: string[];
}

export interface ValidationOk {
  ok: true;
  mode: "single" | "parallel" | "status" | "wait" | "cancel";
  async: boolean;
  id?: string;
  tasks: ResolvedTask[];
}

export interface ValidationErr {
  ok: false;
  error: string;
}

export type ValidationResult = ValidationOk | ValidationErr;

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolvePath(cwd: string, maybe?: string): string {
  if (!maybe) return path.resolve(cwd);
  return path.isAbsolute(maybe) ? path.normalize(maybe) : path.resolve(cwd, maybe);
}

function profileTools(
  profile: TaskProfile,
  requested: string[] | undefined,
  available: Set<string>,
  active: string[],
): { tools: string[]; canWrite: boolean; notes: string[] } {
  const notes: string[] = [];

  if (profile === "explore" || profile === "review") {
    const base = READ_ONLY_TOOLS.filter((t) => available.has(t));
    const requestedSafe = (requested ?? []).filter((t) => {
      if (WRITE_TOOLS.has(t)) {
        notes.push(`Dropped write tool "${t}" from ${profile} profile`);
        return false;
      }
      if (!available.has(t)) {
        notes.push(`Unknown tool "${t}" ignored`);
        return false;
      }
      return true;
    });
    const tools = [...new Set([...base, ...requestedSafe])];
    return { tools, canWrite: false, notes };
  }

  // general
  const source = requested?.length ? requested : active.length ? active : [...available];
  const tools: string[] = [];
  for (const t of source) {
    if (!available.has(t)) {
      notes.push(`Unknown tool "${t}" ignored`);
      continue;
    }
    tools.push(t);
  }
  const canWrite = tools.some((t) => WRITE_TOOLS.has(t));
  return { tools, canWrite, notes };
}

function normalizeTaskItem(
  item: {
    task: string;
    system_prompt?: string;
    model?: string;
    thinking?: TaskSpec["thinking"];
    tools?: string[];
    profile?: TaskProfile;
    cwd?: string;
    timeout_ms?: number;
    max_turns?: number;
    max_cost?: number;
    output?: string;
    output_mode?: OutputMode;
    resume?: string;
    fork_resume?: boolean;
    isolation?: "shared" | "worktree";
    allow_shared_writes?: boolean;
  },
  index: number,
  parent: ParentContext,
  labelPrefix = "task",
): { task?: ResolvedTask; error?: string } {
  if (!isNonBlank(item.task)) {
    return { error: `Task ${index + 1} is empty` };
  }
  if (item.output_mode && !item.output) {
    return { error: `Task ${index + 1}: output_mode requires output` };
  }
  if (item.timeout_ms !== undefined && (!Number.isFinite(item.timeout_ms) || item.timeout_ms < 1)) {
    return { error: `Task ${index + 1}: timeout_ms must be a positive number` };
  }
  if (item.max_turns !== undefined && (!Number.isInteger(item.max_turns) || item.max_turns < 1)) {
    return { error: `Task ${index + 1}: max_turns must be a positive integer` };
  }
  if (item.max_cost !== undefined && (!Number.isFinite(item.max_cost) || item.max_cost < 0)) {
    return { error: `Task ${index + 1}: max_cost must be >= 0` };
  }
  if (item.fork_resume && !item.resume) {
    return { error: `Task ${index + 1}: fork_resume requires resume` };
  }

  const available = new Set(parent.availableTools);
  const profile: TaskProfile = item.profile ?? "general";
  const active = parent.activeTools ?? parent.availableTools;
  const resolvedTools = profileTools(profile, item.tools, available, active);

  const cwd = resolvePath(parent.cwd, item.cwd);
  const output = item.output ? resolvePath(cwd, item.output) : undefined;
  const notes = [...resolvedTools.notes];
  notes.push(`profile=${profile} canWrite=${resolvedTools.canWrite}`);

  const task: ResolvedTask = {
    label: `${labelPrefix}-${index + 1}`,
    task: item.task.trim(),
    systemPrompt: item.system_prompt,
    model: item.model || parent.model,
    thinking: item.thinking ?? parent.thinking,
    tools: resolvedTools.tools,
    profile,
    cwd,
    timeoutMs: item.timeout_ms ?? defaultConfig.defaultTimeoutMs,
    maxTurns: item.max_turns,
    maxCost: item.max_cost,
    output,
    outputMode: item.output_mode,
    resume: item.resume,
    forkResume: item.fork_resume,
    isolation: item.isolation ?? "shared",
    allowSharedWrites: item.allow_shared_writes === true,
    canWrite: resolvedTools.canWrite,
    effectiveTools: resolvedTools.tools,
    resolutionNotes: notes,
  };

  return { task };
}

function guardParallelWrites(tasks: ResolvedTask[]): string | undefined {
  const writers = tasks.filter((t) => t.canWrite);
  if (writers.length < 2) return undefined;

  const groups = new Map<string, ResolvedTask[]>();
  for (const t of writers) {
    const key = resolvePath(t.cwd ?? process.cwd());
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  for (const [cwd, group] of groups) {
    if (group.length < 2) continue;
    const allSafe = group.every((t) => t.isolation === "worktree" || t.allowSharedWrites);
    if (!allSafe) {
      return (
        `Parallel write-capable tasks share cwd ${cwd}. ` +
        `Use isolation:"worktree", distinct cwd values, or allow_shared_writes:true (unsafe).`
      );
    }
  }
  return undefined;
}

function guardDuplicateOutputs(tasks: ResolvedTask[]): string | undefined {
  const seen = new Map<string, string>();
  for (const t of tasks) {
    if (!t.output) continue;
    const prev = seen.get(t.output);
    if (prev) return `Duplicate output path ${t.output} used by ${prev} and ${t.label}`;
    seen.set(t.output, t.label);
  }
  return undefined;
}

export function parseDepth(envValue = process.env[DEPTH_ENV_VAR]): number {
  const n = Number.parseInt(envValue ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100);
}

/**
 * Validate raw tool parameters after TypeBox matching.
 * Produces normalized `TaskSpec`s ready for the runner.
 */
export function validateSubagentRequest(
  params: SubagentParams,
  parent: ParentContext,
  options?: { maxDepth?: number; maxTasks?: number },
): ValidationResult {
  const maxDepth = options?.maxDepth ?? defaultConfig.maxDepth;
  const maxTasks = options?.maxTasks ?? defaultConfig.maxTasksPerRun;
  const depth = parent.depth ?? parseDepth();

  if (depth >= maxDepth) {
    return {
      ok: false,
      error: `Subagent nesting depth limit reached (${depth} >= ${maxDepth}). Nested agents are capped to prevent process storms.`,
    };
  }

  if ("action" in params && params.action) {
    return {
      ok: true,
      mode: params.action,
      async: false,
      id: "id" in params ? params.id : undefined,
      tasks: [],
    };
  }

  if ("tasks" in params && Array.isArray(params.tasks)) {
    if (params.tasks.length < 1 || params.tasks.length > maxTasks) {
      return { ok: false, error: `Parallel mode requires 1..${maxTasks} tasks` };
    }

    const tasks: ResolvedTask[] = [];
    for (let i = 0; i < params.tasks.length; i++) {
      const item = params.tasks[i] as ParallelTaskInput;
      // Default parallel workers to explore unless explicitly general/review
      const withDefault: ParallelTaskInput = {
        ...item,
        profile: item.profile ?? "explore",
      };
      const r = normalizeTaskItem(withDefault, i, parent, "p");
      if (r.error || !r.task) return { ok: false, error: r.error ?? "Invalid task" };
      tasks.push(r.task);
    }

    const writeErr = guardParallelWrites(tasks);
    if (writeErr) return { ok: false, error: writeErr };
    const outErr = guardDuplicateOutputs(tasks);
    if (outErr) return { ok: false, error: outErr };

    return {
      ok: true,
      mode: "parallel",
      async: params.async === true,
      tasks,
    };
  }

  if ("task" in params && isNonBlank(params.task)) {
    const r = normalizeTaskItem(params, 0, parent, "task");
    if (r.error || !r.task) return { ok: false, error: r.error ?? "Invalid task" };
    const outErr = guardDuplicateOutputs([r.task]);
    if (outErr) return { ok: false, error: outErr };
    return {
      ok: true,
      mode: "single",
      async: params.async === true,
      tasks: [r.task],
    };
  }

  return {
    ok: false,
    error: "Provide { task }, { tasks }, or { action: status|wait|cancel, id? }",
  };
}

export function describeCapability(task: ResolvedTask): string {
  return `${task.profile}/${task.canWrite ? "RW" : "RO"} tools=[${task.effectiveTools.join(",")}]`;
}
