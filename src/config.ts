import * as os from "node:os";
import * as path from "node:path";

export interface SubagentConfig {
  maxTasksPerRun: number;
  maxActiveProcesses: number;
  maxQueuedTasks: number;
  defaultTimeoutMs: number;
  maxResultBytes: number;
  maxResultLines: number;
  maxDetailsTextBytes: number;
  maxCompletedInMemory: number;
  maxDepth: number;
  sessionDir: string;
  sessionRetentionDays?: number;
}

export const defaultConfig: SubagentConfig = {
  maxTasksPerRun: 8,
  maxActiveProcesses: 4,
  maxQueuedTasks: 32,
  defaultTimeoutMs: 15 * 60_000,
  maxResultBytes: 50 * 1024,
  maxResultLines: 2_000,
  maxDetailsTextBytes: 10 * 1024,
  maxCompletedInMemory: 20,
  maxDepth: 2,
  sessionDir: path.join(os.homedir(), ".pi", "subagent-sessions"),
};
