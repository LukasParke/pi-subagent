import * as path from "node:path";
import type { AgentDefinition } from "./agents.js";
import { resolveAgent } from "./agents.js";
import { defaultConfig, type TaskDefaults, type TaskDefaultsByProfile } from "./config.js";
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
  /** Persisted parent session file; required for context:'fork'. */
  sessionFile?: string;
}

export interface ResolvedTask extends TaskSpec {
  label: string;
  canWrite: boolean;
  effectiveTools: string[];
  resolutionNotes: string[];
}

export type ManagementMode = "status" | "wait" | "cancel" | "steer" | "diff" | "apply" | "discard";

export type ValidationResult =
  | {
      ok: true;
      mode: "single" | "parallel" | ManagementMode;
      async: boolean;
      id?: string;
      message?: string;
      index?: number;
      synthesis?: string;
      tasks: ResolvedTask[];
    }
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
    agent?: string;
    description?: string;
    system_prompt?: string;
    model?: string;
    thinking?: TaskSpec["thinking"];
    tools?: string[];
    profile?: TaskProfile;
    cwd?: string;
    timeout_ms?: number;
    max_turns?: number;
    max_cost?: number;
    grace_turns?: number;
    fallback_models?: string[];
    max_retries?: number;
    context?: "fresh" | "fork";
    output?: string;
    output_mode?: OutputMode;
    resume?: string;
    fork_resume?: boolean;
    isolation?: "shared" | "worktree";
    allow_shared_writes?: boolean;
    keep_background?: boolean;
  },
  index: number,
  parent: ParentContext,
  defaultProfile: TaskProfile,
  defaults: { timeoutMs?: number; taskDefaults?: TaskDefaultsByProfile; agents?: Map<string, AgentDefinition> } = {},
): { task?: ResolvedTask; error?: string } {
  if (!item.task?.trim()) return { error: `Task ${index + 1} must not be blank` };

  // Named agent resolution: the agent file supplies persona defaults; explicit
  // request params still win field-by-field. The agent body is the child's
  // system prompt; an explicit system_prompt is appended after it.
  let agent: AgentDefinition | undefined;
  if ((item as { agent?: string }).agent) {
    const lookup = resolveAgent(defaults.agents ?? new Map(), (item as { agent?: string }).agent!);
    if (!lookup.agent) return { error: `Task ${index + 1}: ${lookup.error}` };
    agent = lookup.agent;
  }
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
  if (item.grace_turns !== undefined && (!Number.isInteger(item.grace_turns) || item.grace_turns < 0)) {
    return { error: `Task ${index + 1}: grace_turns must be a non-negative integer` };
  }
  if (item.max_retries !== undefined && (!Number.isInteger(item.max_retries) || item.max_retries < 0)) {
    return { error: `Task ${index + 1}: max_retries must be a non-negative integer` };
  }
  if (item.context === "fork") {
    if (item.resume) return { error: `Task ${index + 1}: context:'fork' cannot be combined with resume (resume already carries its own context)` };
    if (!parent.sessionFile) {
      return { error: `Task ${index + 1}: context:'fork' requires a persisted parent session; this session has no session file. Use context:'fresh'.` };
    }
  }

  const profile = item.profile ?? agent?.profile ?? defaultProfile;
  const requestedTools = item.tools ?? agent?.tools;
  const resolved = resolveTools(profile, requestedTools, parent.availableTools, parent.activeTools ?? parent.availableTools);
  if (resolved.error || !resolved.tools || resolved.canWrite === undefined) return { error: resolved.error ?? "Tool resolution failed" };
  const cwd = resolvePath(parent.cwd, item.cwd);
  const output = item.output ? resolvePath(cwd, item.output) : undefined;
  // Precedence: explicit request > agent file > per-profile config defaults > parent inheritance.
  const profileDefaults: TaskDefaults = defaults.taskDefaults?.[profile] ?? {};
  const label = item.description?.trim()
    ? item.description.trim().slice(0, 60)
    : agent
      ? agent.name
      : `task-${index + 1}`;
  const systemPrompt = [agent?.systemPrompt, item.system_prompt].filter(Boolean).join("\n\n") || undefined;
  return {
    task: {
      label,
      task: item.task.trim(),
      systemPrompt,
      model: item.model || agent?.model || profileDefaults.model || parent.model,
      thinking: item.thinking ?? agent?.thinking ?? profileDefaults.thinking ?? parent.thinking,
      tools: resolved.tools,
      profile,
      cwd,
      timeoutMs: item.timeout_ms ?? agent?.timeoutMs ?? profileDefaults.timeoutMs ?? defaults.timeoutMs ?? defaultConfig.defaultTimeoutMs,
      maxTurns: item.max_turns ?? agent?.maxTurns ?? profileDefaults.maxTurns,
      maxCost: item.max_cost ?? agent?.maxCost ?? profileDefaults.maxCost,
      graceTurns: item.grace_turns ?? agent?.graceTurns,
      fallbackModels: item.fallback_models?.filter(Boolean).length
        ? item.fallback_models.filter(Boolean)
        : agent?.fallbackModels ?? profileDefaults.fallbackModels,
      maxRetries: item.max_retries ?? agent?.maxRetries ?? profileDefaults.maxRetries,
      contextFork: item.context === "fork",
      parentSessionFile: item.context === "fork" ? parent.sessionFile : undefined,
      output,
      outputMode: item.output_mode,
      resume: item.resume,
      forkResume: item.fork_resume,
      isolation: item.isolation ?? agent?.isolation ?? "shared",
      allowSharedWrites: item.allow_shared_writes === true,
      keepBackground: item.keep_background === true,
      canWrite: resolved.canWrite,
      effectiveTools: resolved.tools,
      resolutionNotes: [
        `profile=${profile}`,
        `access=${resolved.canWrite ? "RW" : "RO"}`,
        ...(agent ? [`agent=${agent.name}`] : []),
      ],
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

/**
 * Parse nesting depth. Missing (undefined / empty) means top-level (0).
 * Malformed or negative values fail *closed* by returning a large sentinel so
 * the depth-cap check rejects nested work rather than resetting the counter
 * after env scrubbing after a forged zero.
 */
export function parseDepth(value = process.env[DEPTH_ENV_VAR]): number {
  if (value === undefined || value === "") return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 100; // fail closed
  return Math.min(parsed, 100);
}

/** True when this process should avoid spawning further nested subagents. */
export function shouldRegisterSubagentTool(
  depth = parseDepth(),
  maxDepth = defaultConfig.maxDepth,
): boolean {
  return depth < maxDepth;
}

export function validateSubagentRequest(
  params: SubagentParams,
  parent: ParentContext,
  options: {
    maxDepth?: number;
    maxTasks?: number;
    defaultTimeoutMs?: number;
    taskDefaults?: TaskDefaultsByProfile;
    agents?: Map<string, AgentDefinition>;
  } = {},
): ValidationResult {
  const defaults = { timeoutMs: options.defaultTimeoutMs, taskDefaults: options.taskDefaults, agents: options.agents };
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
    if (params.action !== "status" && !params.id) {
      return { ok: false, error: `${params.action} requires a run id` };
    }
    if (params.action === "steer" && !params.message?.trim()) {
      return { ok: false, error: "steer requires a non-empty message" };
    }
    // Management actions ignore task-config fields; reject obvious conflict residues.
    if (params.async !== undefined) {
      return { ok: false, error: "async cannot be combined with action" };
    }
    return { ok: true, mode: params.action!, async: false, id: params.id, message: params.message, index: params.index, tasks: [] };
  }

  if (hasTasks) {
    const rawTasks = params.tasks!;
    const maxTasks = options.maxTasks ?? defaultConfig.maxTasksPerRun;
    if (!rawTasks.length || rawTasks.length > maxTasks) return { ok: false, error: `Expected 1..${maxTasks} tasks (configurable via maxTasksPerRun)` };
    // Top-level TaskFields apply only to single-task mode.
    if (params.system_prompt !== undefined || params.model !== undefined || params.tools !== undefined || params.profile !== undefined || params.cwd !== undefined || params.resume !== undefined || params.agent !== undefined) {
      return { ok: false, error: "Top-level task options cannot be combined with tasks[]; set them on each tasks[] item" };
    }
    // Context forking duplicates the whole parent conversation per child;
    // that cost is intentional for one focused writer, not an 8-way fanout.
    if (rawTasks.length > 1 && rawTasks.some((task) => task.context === "fork")) {
      return { ok: false, error: "context:'fork' is single-task only; parallel fanout would duplicate the parent conversation per child" };
    }
    const tasks: ResolvedTask[] = [];
    for (let index = 0; index < rawTasks.length; index++) {
      const normalized = normalizeTask(rawTasks[index] as ParallelTaskInput, index, parent, "explore", defaults);
      if (normalized.error || !normalized.task) return { ok: false, error: normalized.error ?? "Invalid task" };
      tasks.push(normalized.task);
    }
    const parallelError = validateParallel(tasks);
    if (parallelError) return { ok: false, error: parallelError };
    return {
      ok: true,
      mode: tasks.length > 1 ? "parallel" : "single",
      async: params.async === true,
      synthesis: params.synthesis?.trim() || undefined,
      tasks,
    };
  }

  if (params.synthesis !== undefined) {
    return { ok: false, error: "synthesis applies to parallel mode only (tasks[])" };
  }
  // Single-task mode: top-level fields form the one task.
  const normalized = normalizeTask(params as ParallelTaskInput, 0, parent, "general", defaults);
  if (normalized.error || !normalized.task) return { ok: false, error: normalized.error ?? "Invalid task" };
  return { ok: true, mode: "single", async: params.async === true, tasks: [normalized.task] };
}

export function describeCapability(task: ResolvedTask): string {
  return `${task.profile}/${task.canWrite ? "RW" : "RO"} tools=[${task.effectiveTools.join(",")}]`;
}
