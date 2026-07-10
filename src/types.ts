import type { Message } from "@earendil-works/pi-ai";

export type RunMode = "single" | "parallel";
export type RunState = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "lost";
export type TaskProfile = "explore" | "review" | "general";
export type OutputMode = "inline" | "file-only";

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
  errorMessage?: string;
  index?: number;
  outputFile?: string;
  outputMode?: OutputMode;
  worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  liveText?: string;
  protocol: {
    headerSeen: boolean;
    assistantEndSeen: boolean;
    agentEndSeen: boolean;
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
  results: Array<{
    label: string;
    task: string;
    state: RunState;
    exitCode: number | null;
    stopReason?: string;
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
    finalOutput?: string;
    transcript?: string;
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
