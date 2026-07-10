import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskResult, TaskSpec, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { ProtocolParser, type ProtocolUpdate } from "./protocol.js";
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

/** Owns exactly one child Pi process and its process tree. */
export class ChildRunner {
  constructor(
    private readonly semaphore = new Semaphore(defaultConfig.maxActiveProcesses, defaultConfig.maxQueuedTasks),
    private readonly getPiCommand: GetPiCommand = (args) => ({ command: "pi", args }),
    private readonly sessionDir = defaultConfig.sessionDir,
    private readonly onCheckpoint?: (result: Partial<TaskResult>) => void,
    private readonly killGraceMs = 3_000,
  ) {}

  async run(spec: TaskSpec, abortSignal?: AbortSignal): Promise<TaskResult> {
    const startedAt = Date.now();
    const result: TaskResult = {
      label: "subagent",
      task: spec.task,
      state: "queued",
      exitCode: null,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      outputFile: spec.output,
      outputMode: spec.outputMode,
      thinking: spec.thinking,
      profile: spec.profile,
      canWrite: spec.canWrite,
      startedAt,
      protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, validEvents: 0, parseErrors: 0 },
    };

    let processHandle: ChildProcess | undefined;
    let slotHeld = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let tempPromptDir: string | undefined;
    let requestedStop: "cancelled" | "timeout" | "max_turns" | "max_cost" | undefined;
    let abortHandler: (() => void) | undefined;
    let stderr = "";
    const parser = new ProtocolParser();

    const release = () => {
      if (!slotHeld) return;
      slotHeld = false;
      this.semaphore.release();
    };

    const forceKillTree = () => {
      const pid = processHandle?.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            shell: false,
            stdio: "ignore",
          });
          killer.unref();
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          try { processHandle?.kill("SIGKILL"); } catch { /* best effort */ }
        }
      }
    };

    const requestStop = (reason: typeof requestedStop) => {
      if (!requestedStop) requestedStop = reason;
      // Cancellation may arrive before spawn. In that case remember the reason,
      // then a second call immediately after spawn performs the actual signal.
      if (forceKillTimer) return;
      const pid = processHandle?.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T"], { shell: false, stdio: "ignore" });
          killer.unref();
        } else {
          process.kill(-pid, "SIGTERM");
        }
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          try { processHandle?.kill("SIGTERM"); } catch { /* best effort */ }
        }
      }
      forceKillTimer = setTimeout(forceKillTree, this.killGraceMs);
      forceKillTimer.unref?.();
    };

    const cleanup = async () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
      processHandle?.stdout?.removeAllListeners();
      processHandle?.stderr?.removeAllListeners();
      processHandle?.removeAllListeners();
      if (tempPromptDir) await fs.rm(tempPromptDir, { recursive: true, force: true }).catch(() => {});
      release();
    };

    const progress = (partial: Partial<TaskResult>) => {
      Object.assign(result, partial);
      this.onCheckpoint?.({ ...result, liveText: parser.getLiveText() });
    };

    const handleUpdates = (updates: ProtocolUpdate[]) => {
      for (const update of updates) {
        if (update.type === "session") progress({ sessionId: update.sessionId });
        if (update.type === "live-text") progress({ liveText: update.liveText });
        if (update.type === "message") {
          result.messages = parser.getMessages();
          result.usage = update.usage;
          progress({ messages: result.messages, usage: result.usage, liveText: parser.getLiveText() });
          const budget = this.checkBudgets(spec, result.usage);
          if (budget) requestStop(budget);
        }
      }
    };

    try {
      if (abortSignal?.aborted) {
        result.state = "cancelled";
        result.stopReason = "cancelled";
        result.exitCode = 1;
        result.endedAt = Date.now();
        return result;
      }

      await this.semaphore.acquire(abortSignal);
      slotHeld = true;
      if (abortSignal?.aborted) throw new Error("Subagent cancelled before spawn");
      if (abortSignal) {
        abortHandler = () => requestStop("cancelled");
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
      result.state = "running";
      progress({ state: "running" });

      await fs.mkdir(this.sessionDir, { recursive: true });
      if (abortSignal?.aborted) throw new Error("Subagent cancelled before spawn");
      const args = ["--mode", "json", "-p", "--session-dir", this.sessionDir];
      if (spec.forkResume && spec.resume) args.push("--fork", spec.resume);
      else if (spec.resume) args.push("--session", spec.resume);
      if (spec.model) args.push("--model", spec.model);
      if (spec.thinking) args.push("--thinking", spec.thinking);
      if (spec.tools !== undefined) {
        const tools = spec.tools.filter((tool) => tool !== "subagent");
        if (tools.length === 0) args.push("--no-tools");
        else args.push("--tools", tools.join(","));
      }
      if (spec.systemPrompt?.trim()) {
        tempPromptDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
        const promptPath = path.join(tempPromptDir, "system-prompt.md");
        await fs.writeFile(promptPath, spec.systemPrompt, { encoding: "utf8", mode: 0o600 });
        args.push("--append-system-prompt", promptPath);
      }

      const invocation = this.getPiCommand(args);
      const depth = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10) || 0;
      processHandle = spawn(invocation.command, invocation.args, {
        cwd: spec.cwd || process.cwd(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, [DEPTH_ENV_VAR]: String(depth + 1) },
      });
      if (abortSignal?.aborted) requestStop("cancelled");

      processHandle.stdout?.on("data", (chunk: Buffer) => handleUpdates(parser.feed(chunk)));
      processHandle.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-50 * 1024);
        result.stderr = stderr;
      });
      processHandle.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        // EPIPE is expected when a child fails before consuming stdin.
        if (error.code !== "EPIPE") result.errorMessage = `stdin error: ${error.message}`;
      });
      processHandle.stdin?.end(spec.task); // stdin only: no argv duplication or option parsing

      timeout = setTimeout(() => requestStop("timeout"), spec.timeoutMs);
      timeout.unref?.();

      const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        let settled = false;
        const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        processHandle!.once("close", (code, signal) => finish({ code, signal }));
        processHandle!.once("error", (error) => finish({ code: 1, signal: null, error }));
      });

      handleUpdates(parser.flush());
      // The child owns a dedicated process group. Reap descendants even when the
      // direct Pi process exits normally after a tool backgrounds work.
      forceKillTree();
      const finalized = parser.finalize(closed.code, closed.signal ?? undefined, stderr);
      Object.assign(result, finalized, {
        label: result.label,
        task: spec.task,
        outputFile: spec.output,
        outputMode: spec.outputMode,
        thinking: spec.thinking,
        profile: spec.profile,
        canWrite: spec.canWrite,
        startedAt,
        endedAt: Date.now(),
      });

      if (closed.error) {
        result.state = "failed";
        result.stopReason = "spawn_error";
        result.errorMessage = closed.error.message;
      } else if (requestedStop) {
        result.state = requestedStop === "cancelled" ? "cancelled" : "failed";
        result.stopReason = requestedStop;
        result.exitCode = closed.code;
      }
      return result;
    } catch (error: any) {
      result.state = abortSignal?.aborted || /cancel/i.test(String(error?.message)) ? "cancelled" : "failed";
      result.stopReason = result.state === "cancelled" ? "cancelled" : "error";
      result.errorMessage = error?.message ?? String(error);
      result.exitCode ??= 1;
      result.endedAt = Date.now();
      return result;
    } finally {
      await cleanup();
    }
  }

  private checkBudgets(spec: TaskSpec, usage: UsageStats): "max_turns" | "max_cost" | undefined {
    // Stop only after a completed turn has pushed usage beyond the configured ceiling.
    if (spec.maxTurns !== undefined && usage.turns > spec.maxTurns) return "max_turns";
    if (spec.maxCost !== undefined && usage.cost > spec.maxCost) return "max_cost";
    return undefined;
  }
}

export function runSubagent(spec: TaskSpec, options: RunnerOptions & { signal?: AbortSignal } = {}): Promise<TaskResult> {
  return new ChildRunner(
    options.semaphore,
    options.getPiCommand,
    options.sessionDir,
    options.onCheckpoint,
    options.killGraceMs,
  ).run(spec, options.signal);
}
