import type { Message } from "@earendil-works/pi-ai";

export type RunMode = "single" | "parallel";
export type RunState = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "lost" | "timeout";
/** Distinct timeout phases so agents can retry queue pressure without "fixing" unfinished work. */
export type TimeoutPhase = "queued" | "starting" | "running" | "cancelling";
export type TaskProfile = "explore" | "review" | "general";
export type OutputMode = "inline" | "file-only";

/** Durable identity of a spawned child process for orphan reconcile. */
export interface ChildProcessIdentity {
  pid: number;
  /** Platform-specific process start identity; 0 when unknown. */
  startTime: number;
  pgid?: number;
  hostname?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning is a subset of output when providers report it. */
  reasoning?: number;
  /** Provider-reported total cost. */
  cost: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  /** Most recent turn's context size; not additive across turns. */
  contextTokens: number;
  turns: number;
}

export interface TaskSpec {
  task: string;
  /** Short human label shown in UIs and result indexes. */
  label?: string;
  systemPrompt?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  profile: TaskProfile;
  canWrite?: boolean;
  cwd?: string;
  timeoutMs: number;
  maxTurns?: number;
  maxCost?: number;
  output?: string;
  outputMode?: OutputMode;
  resume?: string;
  forkResume?: boolean;
  isolation?: "shared" | "worktree";
  allowSharedWrites?: boolean;
  /** Opt out of process-tree reaping after a clean exit (e.g. child-started dev servers). */
  keepBackground?: boolean;
  /** Wrap-up grace turns after a max_turns/max_cost breach before SIGTERM. 0 = immediate stop. */
  graceTurns?: number;
  /** Ordered backup models tried on transient provider failures. */
  fallbackModels?: string[];
  /** Extra attempts on transient failures (queue timeout, stall, provider error). */
  maxRetries?: number;
  /** Fork the parent conversation into the child (real branched session). */
  contextFork?: boolean;
  /** Parent session file used for contextFork. */
  parentSessionFile?: string;
}

export interface TaskResult {
  label: string;
  task: string;
  state: RunState;
  exitCode: number | null;
  signal?: NodeJS.Signals;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  thinking?: TaskSpec["thinking"];
  profile?: TaskProfile;
  canWrite?: boolean;
  stopReason?: string;
  /** Present when stopReason is a timeout-like outcome. */
  timeoutPhase?: TimeoutPhase;
  errorMessage?: string;
  index?: number;
  outputFile?: string;
  outputMode?: OutputMode;
  worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
  sessionId?: string;
  /** Child process identity (persisted for orphan reclaim). */
  process?: ChildProcessIdentity;
  startedAt?: number;
  /** When the semaphore slot was acquired (runtime clock starts here). */
  acquiredAt?: number;
  endedAt?: number;
  liveText?: string;
  /** Incrementally-built compact transcript (assistant text, tool calls, tool results). */
  transcript?: string;
  /** True when a budget-stopped child wrapped up gracefully in its grace turns. */
  wrappedUp?: boolean;
  /** Set while no protocol activity has been seen for the stall window. */
  stalledSince?: number;
  /** Total attempts including retries (present when > 1). */
  attempts?: number;
  /** Models tried across attempts, in order. */
  attemptedModels?: string[];
  protocol: {
    headerSeen: boolean;
    assistantEndSeen: boolean;
    agentEndSeen: boolean;
    agentSettledSeen: boolean;
    validEvents: number;
    parseErrors: number;
  };
}

export interface RunSnapshot {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  mode: RunMode;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  taskPreviews: string[];
  summary?: string;
  delivered: boolean;
  /** True when a previous owner was killed on reconcile; resume must not auto-reopen. */
  resumeBlocked?: boolean;
  results: Array<{
    label: string;
    task: string;
    state: RunState;
    exitCode: number | null;
    stopReason?: string;
    timeoutPhase?: TimeoutPhase;
    errorMessage?: string;
    usage: UsageStats;
    model?: string;
    thinking?: TaskSpec["thinking"];
    profile?: TaskProfile;
    canWrite?: boolean;
    outputFile?: string;
    outputMode?: OutputMode;
    worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
    sessionId?: string;
    process?: ChildProcessIdentity;
    finalOutput?: string;
    transcript?: string;
    wrappedUp?: boolean;
    stalledSince?: number;
    attempts?: number;
    attemptedModels?: string[];
  }>;
}

export interface ToolDetails {
  mode: RunMode;
  results: TaskResult[];
}

export const emptyUsage = (): UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  costInput: 0,
  costOutput: 0,
  costCacheRead: 0,
  costCacheWrite: 0,
  contextTokens: 0,
  turns: 0,
});
