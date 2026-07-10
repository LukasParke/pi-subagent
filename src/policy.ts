import * as path from "node:path";
import { defaultConfig } from "./config.js";
import type { OutputMode, TaskProfile, TaskSpec } from "./types.js";
import type { ParallelTaskInput, SubagentParams } from "./schema.js";

export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "firecrawl_scrape",
  "firecrawl_search",
  "firecrawl_map",
  "firecrawl_crawl",
  "web_search",
  "web_fetch",
]);
export const KNOWN_WRITE_TOOLS = new Set(["bash", "edit", "write"]);
/** Backward-compatible export; policy uses fail-closed classification above. */
export const WRITE_TOOLS = KNOWN_WRITE_TOOLS;

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
  resolutionNotes: string[];
}

export type ValidationResult =
  | { ok: true; mode: "single" | "parallel" | "status" | "wait" | "cancel"; async: boolean; id?: string; tasks: ResolvedTask[] }
  | { ok: false; error: string };

function resolvePath(cwd: string, value?: string): string {
  return value ? (path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)) : path.resolve(cwd);
}

function resolveTools(
  profile: TaskProfile,
  requested: string[] | undefined,
  availableTools: string[],
  activeTools: string[],
): { tools?: string[]; canWrite?: boolean; error?: string } {
  const available = new Set(availableTools);
  if (requested) {
    const unknown = requested.filter((tool) => !available.has(tool));
    if (unknown.length) return { error: `Unknown or unavailable tools: ${unknown.join(", ")}` };
  }

  if (profile === "explore" || profile === "review") {
    const source = requested ?? [...READ_ONLY_TOOLS].filter((tool) => available.has(tool));
    const unsafe = source.filter((tool) => !READ_ONLY_TOOLS.has(tool));
    if (unsafe.length) {
      return {
        error: `${profile} is strictly read-only. Unclassified or writable tools are not allowed: ${unsafe.join(", ")}`,
      };
    }
    return { tools: [...new Set(source)], canWrite: false };
  }

  const source = requested ?? activeTools;
  const unknown = source.filter((tool) => !available.has(tool));
  if (unknown.length) return { error: `Active tools are unavailable: ${unknown.join(", ")}` };
  // General-profile custom tools are conservatively write-capable unless explicitly known read-only.
  return {
    tools: [...new Set(source)],
    canWrite: source.some((tool) => KNOWN_WRITE_TOOLS.has(tool) || !READ_ONLY_TOOLS.has(tool)),
  };
}

function normalizeTask(
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
  defaultProfile: TaskProfile,
): { task?: ResolvedTask; error?: string } {
  if (!item.task?.trim()) return { error: `Task ${index + 1} must not be blank` };
  if (item.output_mode && !item.output) return { error: `Task ${index + 1}: output_mode requires output` };
  if (item.fork_resume && !item.resume) return { error: `Task ${index + 1}: fork_resume requires resume` };
  if (item.timeout_ms !== undefined && (!Number.isInteger(item.timeout_ms) || item.timeout_ms < 1)) {
    return { error: `Task ${index + 1}: timeout_ms must be a positive integer` };
  }
  if (item.max_turns !== undefined && (!Number.isInteger(item.max_turns) || item.max_turns < 1)) {
    return { error: `Task ${index + 1}: max_turns must be a positive integer` };
  }
  if (item.max_cost !== undefined && (!Number.isFinite(item.max_cost) || item.max_cost < 0)) {
    return { error: `Task ${index + 1}: max_cost must be >= 0` };
  }

  const profile = item.profile ?? defaultProfile;
  const resolved = resolveTools(profile, item.tools, parent.availableTools, parent.activeTools ?? parent.availableTools);
  if (resolved.error || !resolved.tools || resolved.canWrite === undefined) return { error: resolved.error ?? "Tool resolution failed" };
  const cwd = resolvePath(parent.cwd, item.cwd);
  const output = item.output ? resolvePath(cwd, item.output) : undefined;
  return {
    task: {
      label: `task-${index + 1}`,
      task: item.task.trim(),
      systemPrompt: item.system_prompt,
      model: item.model || parent.model,
      thinking: item.thinking ?? parent.thinking,
      tools: resolved.tools,
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
      canWrite: resolved.canWrite,
      effectiveTools: resolved.tools,
      resolutionNotes: [`profile=${profile}`, `access=${resolved.canWrite ? "RW" : "RO"}`],
    },
  };
}

function validateParallel(tasks: ResolvedTask[]): string | undefined {
  const outputs = new Set<string>();
  for (const task of tasks) {
    if (task.output && outputs.has(task.output)) return `Duplicate output path: ${task.output}`;
    if (task.output) outputs.add(task.output);
  }

  const sharedByCwd = new Map<string, ResolvedTask[]>();
  for (const task of tasks.filter((task) => task.canWrite && task.isolation !== "worktree")) {
    const list = sharedByCwd.get(task.cwd!) ?? [];
    list.push(task);
    sharedByCwd.set(task.cwd!, list);
  }
  for (const [cwd, writers] of sharedByCwd) {
    if (writers.length > 1 && !writers.every((task) => task.allowSharedWrites)) {
      return `Parallel writers share ${cwd}. Use isolation:"worktree", distinct cwd values, or explicit allow_shared_writes:true.`;
    }
  }
  return undefined;
}

export function parseDepth(value = process.env[DEPTH_ENV_VAR]): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 100) : 0;
}

export function validateSubagentRequest(
  params: SubagentParams,
  parent: ParentContext,
  options: { maxDepth?: number; maxTasks?: number } = {},
): ValidationResult {
  const depth = parent.depth ?? parseDepth();
  const maxDepth = options.maxDepth ?? defaultConfig.maxDepth;
  if (depth >= maxDepth) return { ok: false, error: `Subagent nesting depth limit reached (${depth} >= ${maxDepth})` };

  const hasAction = params.action !== undefined;
  const hasTask = typeof params.task === "string";
  const hasTasks = Array.isArray(params.tasks);
  const modes = [hasAction, hasTask, hasTasks].filter(Boolean).length;
  if (modes === 0) {
    return { ok: false, error: "Provide task, tasks, or action (status|wait|cancel)" };
  }
  if (modes > 1) {
    return { ok: false, error: "Provide exactly one of: action, task, or tasks" };
  }

  if (hasAction) {
    if ((params.action === "wait" || params.action === "cancel") && !params.id) {
      return { ok: false, error: `${params.action} requires a run id` };
    }
    // Management actions ignore task-config fields; reject obvious conflict residues.
    if (params.async !== undefined) {
      return { ok: false, error: "async cannot be combined with action" };
    }
    return { ok: true, mode: params.action!, async: false, id: params.id, tasks: [] };
  }

  if (hasTasks) {
    const rawTasks = params.tasks!;
    const maxTasks = options.maxTasks ?? defaultConfig.maxTasksPerRun;
    if (!rawTasks.length || rawTasks.length > maxTasks) return { ok: false, error: `Expected 1..${maxTasks} tasks` };
    // Top-level TaskFields apply only to single-task mode.
    if (params.system_prompt !== undefined || params.model !== undefined || params.tools !== undefined || params.profile !== undefined || params.cwd !== undefined || params.resume !== undefined) {
      return { ok: false, error: "Top-level task options cannot be combined with tasks[]; set them on each tasks[] item" };
    }
    const tasks: ResolvedTask[] = [];
    for (let index = 0; index < rawTasks.length; index++) {
      const normalized = normalizeTask(rawTasks[index] as ParallelTaskInput, index, parent, "explore");
      if (normalized.error || !normalized.task) return { ok: false, error: normalized.error ?? "Invalid task" };
      tasks.push(normalized.task);
    }
    const parallelError = validateParallel(tasks);
    if (parallelError) return { ok: false, error: parallelError };
    return { ok: true, mode: tasks.length > 1 ? "parallel" : "single", async: params.async === true, tasks };
  }

  // Single-task mode: top-level fields form the one task.
  const normalized = normalizeTask(params as ParallelTaskInput, 0, parent, "general");
  if (normalized.error || !normalized.task) return { ok: false, error: normalized.error ?? "Invalid task" };
  return { ok: true, mode: "single", async: params.async === true, tasks: [normalized.task] };
}

export function describeCapability(task: ResolvedTask): string {
  return `${task.profile}/${task.canWrite ? "RW" : "RO"} tools=[${task.effectiveTools.join(",")}]`;
}
