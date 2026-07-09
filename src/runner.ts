import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskResult, TaskSpec, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { ProtocolParser } from "./protocol.js";
import { Semaphore } from "./semaphore.js";
import { defaultConfig } from "./config.js";
import { DEPTH_ENV_VAR } from "./policy.js";

export type GetPiCommand = (args: string[]) => { command: string; args: string[] };

export interface RunnerOptions {
  semaphore?: Semaphore;
  getPiCommand?: GetPiCommand;
  sessionDir?: string;
  onCheckpoint?: (result: Partial<TaskResult>) => void;
  killGraceMs?: number;
}

/**
 * Spawns one isolated Pi child for a TaskSpec.
 * Ownership: process lifecycle / protocol / budgets only.
 */
export class ChildRunner {
  private readonly semaphore: Semaphore;
  private readonly getPiCommand: GetPiCommand;
  private readonly sessionDir: string;
  private readonly onCheckpoint?: (result: Partial<TaskResult>) => void;
  private readonly killGraceMs: number;

  constructor(
    semaphore: Semaphore = new Semaphore(
      defaultConfig.maxActiveProcesses,
      defaultConfig.maxQueuedTasks,
    ),
    getPiCommand: GetPiCommand = (args) => ({ command: "pi", args }),
    sessionDir: string = defaultConfig.sessionDir,
    onCheckpoint?: (result: Partial<TaskResult>) => void,
    killGraceMs = 3000,
  ) {
    this.semaphore = semaphore;
    this.getPiCommand = getPiCommand;
    this.sessionDir = sessionDir;
    this.onCheckpoint = onCheckpoint;
    this.killGraceMs = killGraceMs;
  }

  async run(spec: TaskSpec, abortSignal?: AbortSignal): Promise<TaskResult> {
    const startedAt = Date.now();
    const result: TaskResult = {
      label: "subagent",
      task: spec.task,
      state: "running",
      exitCode: null,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      startedAt,
      protocol: {
        headerSeen: false,
        assistantEndSeen: false,
        agentEndSeen: false,
        validEvents: 0,
        parseErrors: 0,
      },
    };

    let proc: ChildProcess | null = null;
    let parser = new ProtocolParser();
    let tempPromptDir: string | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let terminated = false;
    let slotHeld = false;
    let stderrBuffer = "";
    const MAX_STDERR = 50 * 1024;
    let abortHandler: (() => void) | undefined;

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const detachAbort = () => {
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
        abortHandler = undefined;
      }
    };

    const releaseSlot = () => {
      if (slotHeld) {
        this.semaphore.release();
        slotHeld = false;
      }
    };

    const cleanup = async () => {
      clearTimers();
      detachAbort();
      if (proc) {
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.removeAllListeners();
      }
      if (tempPromptDir) {
        try {
          await fs.rm(tempPromptDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        tempPromptDir = null;
      }
      releaseSlot();
    };

    const killProcessTree = (signal: NodeJS.Signals = "SIGTERM") => {
      if (!proc?.pid) return;
      const pid = proc.pid;
      try {
        if (process.platform === "win32") {
          proc.kill(signal);
        } else {
          process.kill(-pid, signal);
        }
      } catch (e: any) {
        if (e?.code !== "ESRCH") {
          try {
            proc.kill(signal);
          } catch {
            // ignore
          }
        }
      }

      if (signal !== "SIGKILL") {
        killTimer = setTimeout(() => {
          try {
            if (process.platform === "win32") {
              proc?.kill("SIGKILL");
            } else if (pid) {
              process.kill(-pid, "SIGKILL");
            }
          } catch {
            // ignore
          }
        }, this.killGraceMs);
        // Don't keep the process alive solely for kill grace.
        killTimer.unref?.();
      }
    };

    const markTerminated = (
      code: number | null,
      signal: NodeJS.Signals | undefined,
      stopReason: string,
      state: TaskResult["state"],
    ) => {
      if (terminated) return;
      terminated = true;
      result.endedAt = Date.now();
      result.state = state;
      result.exitCode = code;
      result.signal = signal;
      result.stopReason = stopReason;
      if (proc && !proc.killed) killProcessTree(signal ?? "SIGTERM");
    };

    try {
      if (abortSignal?.aborted) {
        markTerminated(1, undefined, "cancelled", "cancelled");
        return result;
      }

      await this.semaphore.acquire(abortSignal);
      slotHeld = true;

      if (abortSignal?.aborted) {
        markTerminated(1, undefined, "cancelled", "cancelled");
        await cleanup();
        return result;
      }

      await fs.mkdir(this.sessionDir, { recursive: true });

      const args: string[] = ["--mode", "json", "-p", "--session-dir", this.sessionDir];

      if (spec.forkResume && spec.resume) {
        args.push("--fork", spec.resume);
      } else if (spec.resume) {
        args.push("--session", spec.resume);
      }
      if (spec.model) args.push("--model", spec.model);
      if (spec.thinking) args.push("--thinking", spec.thinking);
      if (spec.tools?.length) {
        // Always exclude nested subagent tool to reduce process storms.
        const tools = spec.tools.filter((t) => t !== "subagent");
        if (tools.length === 0) args.push("--no-tools");
        else args.push("--tools", tools.join(","));
      }

      if (spec.systemPrompt?.trim()) {
        tempPromptDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
        const systemPromptPath = path.join(tempPromptDir, "system-prompt.md");
        await fs.writeFile(systemPromptPath, spec.systemPrompt, {
          encoding: "utf-8",
          mode: 0o600,
        });
        args.push("--append-system-prompt", systemPromptPath);
      }

      // Prompt as trailing argument (also mirrored on stdin for compatibility).
      args.push(spec.task);

      const invocation = this.getPiCommand(args);
      const depth = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10) || 0;

      proc = spawn(invocation.command, invocation.args, {
        cwd: spec.cwd || process.cwd(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [DEPTH_ENV_VAR]: String(depth + 1),
        },
        detached: process.platform !== "win32",
      });

      parser = new ProtocolParser();

      const onProgress = (partial: Partial<TaskResult>) => {
        Object.assign(result, partial);
        this.onCheckpoint?.({
          ...result,
          liveText: parser.getLiveText(),
        });
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        const update = parser.feed(chunk);
        if (!update) return;

        if (update.sessionId) {
          result.sessionId = update.sessionId;
          onProgress({ sessionId: update.sessionId });
        }
        if (update.liveTextDelta) {
          onProgress({ liveText: parser.getLiveText() });
        }
        if (update.newMessage) {
          result.messages = [...((parser as any).messages ?? result.messages)];
          onProgress({ messages: result.messages });
        }
        if (update.usageUpdate) {
          result.usage = { ...result.usage, ...update.usageUpdate };
          onProgress({ usage: result.usage });

          const exceeded = this.checkBudgets(spec, result.usage);
          if (exceeded && !terminated) {
            markTerminated(null, undefined, exceeded, "failed");
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        if (stderrBuffer.length > MAX_STDERR) {
          stderrBuffer = stderrBuffer.slice(-MAX_STDERR);
        }
        result.stderr = stderrBuffer;
      });

      if (proc.stdin) {
        proc.stdin.write(spec.task);
        proc.stdin.end();
      }

      if (spec.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (!terminated) markTerminated(null, undefined, "timeout", "failed");
        }, spec.timeoutMs);
        timeoutTimer.unref?.();
      }

      if (abortSignal) {
        abortHandler = () => {
          if (!terminated) markTerminated(null, "SIGTERM", "cancelled", "cancelled");
        };
        if (abortSignal.aborted) abortHandler();
        else abortSignal.addEventListener("abort", abortHandler, { once: true });
      }

      const closeInfo = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        spawnError?: Error;
      }>((resolve) => {
        let settled = false;
        const done = (info: {
          code: number | null;
          signal: NodeJS.Signals | null;
          spawnError?: Error;
        }) => {
          if (settled) return;
          settled = true;
          resolve(info);
        };

        proc!.on("close", (code, signal) => done({ code, signal }));
        proc!.on("error", (err) => {
          result.errorMessage = `Spawn error: ${err.message}`;
          done({ code: 1, signal: null, spawnError: err });
        });
      });

      const finalized = parser.finalize(closeInfo.code, closeInfo.signal ?? undefined, stderrBuffer);
      // Keep task label/input
      finalized.task = spec.task;
      finalized.label = result.label;
      finalized.startedAt = startedAt;
      finalized.endedAt = Date.now();
      finalized.sessionId = result.sessionId ?? finalized.sessionId;
      finalized.usage = {
        ...finalized.usage,
        // prefer live accumulated usage if present
        ...(result.usage.turns > finalized.usage.turns ? result.usage : {}),
      };
      if (result.messages.length > finalized.messages.length) {
        finalized.messages = result.messages;
      }

      if (terminated) {
        // Preserve explicit termination reason/state from timeout/cancel/budget.
        finalized.state = result.state;
        finalized.stopReason = result.stopReason;
        finalized.exitCode = result.exitCode;
        finalized.signal = result.signal;
        finalized.errorMessage = result.errorMessage ?? finalized.errorMessage;
      } else if (closeInfo.signal || closeInfo.code === null) {
        finalized.state = "cancelled";
        finalized.stopReason = "cancelled";
        finalized.exitCode = closeInfo.code;
        finalized.signal = closeInfo.signal ?? undefined;
        if (!finalized.errorMessage) {
          finalized.errorMessage = `Subagent terminated by ${closeInfo.signal ?? "unknown signal"}`;
        }
      } else {
        const budgetStop = this.checkBudgets(spec, finalized.usage);
        if (budgetStop) {
          finalized.state = "failed";
          finalized.stopReason = budgetStop;
        } else if (!finalized.protocol.headerSeen || !finalized.protocol.assistantEndSeen) {
          finalized.state = "failed";
          finalized.stopReason = "protocol_error";
          if (finalized.exitCode === 0) finalized.exitCode = 1;
          finalized.errorMessage =
            finalized.errorMessage ||
            "Child exited without a complete Pi JSON protocol response (session header + assistant message).";
        }
      }

      Object.assign(result, finalized);
      await cleanup();
      return result;
    } catch (err: any) {
      if (!terminated) {
        result.errorMessage = err?.message ?? String(err);
        result.state =
          /aborted/i.test(result.errorMessage ?? "") || abortSignal?.aborted
            ? "cancelled"
            : "failed";
        result.stopReason = result.state === "cancelled" ? "cancelled" : "error";
        result.endedAt = Date.now();
        result.exitCode = result.exitCode ?? 1;
      }
      await cleanup();
      return result;
    }
  }

  private checkBudgets(spec: TaskSpec, usage: UsageStats): "max_turns" | "max_cost" | null {
    if (spec.maxTurns !== undefined && usage.turns > spec.maxTurns) return "max_turns";
    if (spec.maxCost !== undefined && usage.cost > spec.maxCost) return "max_cost";
    return null;
  }
}

export async function runSubagent(
  spec: TaskSpec,
  options?: RunnerOptions & { signal?: AbortSignal },
): Promise<TaskResult> {
  const runner = new ChildRunner(
    options?.semaphore,
    options?.getPiCommand,
    options?.sessionDir,
    options?.onCheckpoint,
    options?.killGraceMs,
  );
  return runner.run(spec, options?.signal);
}
