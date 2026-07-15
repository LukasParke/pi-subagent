import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcessIdentity, TaskResult, TaskSpec, TimeoutPhase, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { ProtocolParser, type ProtocolUpdate } from "./protocol.js";
import { Semaphore } from "./semaphore.js";
import { defaultConfig } from "./config.js";
import { DEPTH_ENV_VAR } from "./policy.js";
import {
  processStartTime,
  type ProcessLockManager,
  type SlotToken,
} from "./process-lock.js";
import { createGetPiCommand } from "./launch.js";

export type GetPiCommand = (args: string[]) => { command: string; args: string[] };

export interface RunnerOptions {
  semaphore?: Semaphore;
  getPiCommand?: GetPiCommand;
  sessionDir?: string;
  onCheckpoint?: (result: Partial<TaskResult>) => void;
  killGraceMs?: number;
  /** Optional durable coordinator for global slots + run process records. */
  locks?: ProcessLockManager;
  /** Run id for durable identity (orphan reconcile). */
  runId?: string;
  /** Parent session key for durable identity. */
  parentSessionKey?: string;
  /** Max task stdin bytes (Guard against runaway prompt buffering). */
  maxTaskBytes?: number;
  /** Wrap-up grace turns after a budget breach (spec.graceTurns overrides). */
  graceTurns?: number;
  /** Protocol-silence window before flagging a running child as stalled. 0 disables. */
  stallAfterMs?: number;
  /** Additional silence after the stall flag before the child is killed. 0 disables kill. */
  stallKillAfterMs?: number;
}

type StopReason = "cancelled" | "timeout" | "max_turns" | "max_cost" | "fatal" | "stalled";

/** Budget stops preserve completed work: they end as "partial", not "failed". */
const BUDGET_STOPS = new Set<StopReason>(["max_turns", "max_cost"]);

const DEFAULT_MAX_TASK_BYTES = 512 * 1024;

const WRAP_UP_MESSAGE =
  "You have reached your budget for this task. Stop all tool use and provide your final answer NOW, " +
  "summarizing what you completed, what remains, and any key findings. This is your last chance to respond.";

/** Owns exactly one child Pi process and its process tree. */
export class ChildRunner {
  /** Live stdin command channel; set while the child process is running. */
  private sendCommand?: (command: unknown) => boolean;
  private readonly graceTurns: number;
  private readonly stallAfterMs: number;
  private readonly stallKillAfterMs: number;

  constructor(
    private readonly semaphore = new Semaphore(defaultConfig.maxActiveProcesses, defaultConfig.maxQueuedTasks),
    private readonly getPiCommand: GetPiCommand = createGetPiCommand(),
    private readonly sessionDir = defaultConfig.sessionDir,
    private readonly onCheckpoint?: (result: Partial<TaskResult>) => void,
    private readonly killGraceMs = defaultConfig.killGraceMs,
    private readonly locks?: ProcessLockManager,
    private readonly runId?: string,
    private readonly parentSessionKey?: string,
    private readonly maxTaskBytes = DEFAULT_MAX_TASK_BYTES,
    options: Pick<RunnerOptions, "graceTurns" | "stallAfterMs" | "stallKillAfterMs"> = {},
  ) {
    this.graceTurns = options.graceTurns ?? defaultConfig.graceTurns;
    this.stallAfterMs = options.stallAfterMs ?? defaultConfig.stallAfterMs;
    this.stallKillAfterMs = options.stallKillAfterMs ?? defaultConfig.stallKillAfterMs;
  }

  /**
   * Queue a steering message into the running child (delivered after the
   * current assistant turn, before the next LLM call). Returns false when the
   * child is not running or its stdin is closed.
   */
  steer(message: string): boolean {
    return this.sendCommand?.({ type: "steer", message }) === true;
  }

  async run(spec: TaskSpec, abortSignal?: AbortSignal): Promise<TaskResult> {
    const startedAt = Date.now();
    const result: TaskResult = {
      label: spec.label ?? "subagent",
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
      protocol: {
        headerSeen: false,
        assistantEndSeen: false,
        agentEndSeen: false,
        agentSettledSeen: false,
        validEvents: 0,
        parseErrors: 0,
      },
    };

    let processHandle: ChildProcess | undefined;
    let slotHeld = false;
    let globalSlot: SlotToken | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let tempPromptDir: string | undefined;
    let requestedStop: StopReason | undefined;
    let fatalError: string | undefined;
    let timeoutPhase: TimeoutPhase | undefined;
    let abortHandler: (() => void) | undefined;
    let stderr = "";
    const parser = new ProtocolParser();
    let spawned = false;
    let acquiredAt: number | undefined;
    let childStartTime = 0;
    // Graceful budget stop state: after a breach the child is steered to wrap
    // up and allowed `graceTurns` more turns before SIGTERM.
    let pendingBudgetStop: { reason: "max_turns" | "max_cost"; deadlineTurns: number } | undefined;
    let wrappedUp = false;
    // Stall watchdog state.
    let lastEventAt = Date.now();
    let stallTimer: NodeJS.Timeout | undefined;
    let stalledAt: number | undefined;

    // Internal signal combines the caller's abort with the run timeout so both
    // interrupt semaphore queue waits. Queue time counts against timeoutMs.
    const internal = new AbortController();
    const onExternalAbort = () => internal.abort();
    if (abortSignal?.aborted) internal.abort();
    else abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      // Record which phase timed out before nightfall.
      timeoutPhase = !slotHeld ? "queued" : !spawned ? "starting" : "running";
      requestStop("timeout");
      internal.abort();
    }, spec.timeoutMs);
    timeout.unref?.();

    const release = () => {
      if (slotHeld) {
        slotHeld = false;
        this.semaphore.release();
      }
      if (globalSlot) {
        this.locks?.releaseGlobalSlot(globalSlot);
        globalSlot = undefined;
      }
    };

    /**
     * Group-kill only when the PID still belongs to our child (start-time
     * identity check guards against PID reuse racing a delayed kill). When
     * identity is unverifiable, fall back to the direct child handle, which
     * Node ties to the real process regardless of PID recycling.
     */
    const pidStillOurs = (pid: number): boolean => {
      if (childStartTime <= 0) return false;
      const live = processStartTime(pid);
      return live > 0 && live === childStartTime;
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
        } else if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
          // Child object still live: group id is safe to use.
          process.kill(-pid, "SIGKILL");
        } else if (pidStillOurs(pid)) {
          process.kill(-pid, "SIGKILL");
        }
        // Child exited and identity is unverifiable: skip the group kill (a
        // recycled PID must never be killed); descendants are covered by the
        // exit-path reap that runs while the handle is still authoritative.
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          try { processHandle?.kill("SIGKILL"); } catch { /* best effort */ }
        }
      }
    };

    const requestStop = (reason: StopReason) => {
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

    const stopStallWatchdog = () => {
      if (stallTimer) clearInterval(stallTimer);
      stallTimer = undefined;
    };

    /**
     * Activity-based stall detection: protocol silence for `stallAfterMs`
     * flags the task as stalled (visible in checkpoints/status); continued
     * silence for `stallKillAfterMs` more kills the child so retry can take
     * over. Any protocol event clears the flag.
     */
    const startStallWatchdog = () => {
      if (this.stallAfterMs <= 0 || stallTimer) return;
      const tick = Math.max(1_000, Math.min(10_000, Math.floor(this.stallAfterMs / 3)));
      stallTimer = setInterval(() => {
        if (requestedStop) return stopStallWatchdog();
        const silence = Date.now() - lastEventAt;
        if (silence < this.stallAfterMs) {
          if (stalledAt !== undefined) {
            stalledAt = undefined;
            result.stalledSince = undefined;
            progress({ stalledSince: undefined });
          }
          return;
        }
        if (stalledAt === undefined) {
          stalledAt = lastEventAt + this.stallAfterMs;
          result.stalledSince = stalledAt;
          progress({ stalledSince: stalledAt });
          // Cheap liveness probe: a healthy-but-quiet child answers get_state,
          // which itself counts as protocol activity and clears the flag.
          this.sendCommand?.({ type: "get_state" });
          return;
        }
        if (this.stallKillAfterMs > 0 && silence >= this.stallAfterMs + this.stallKillAfterMs) {
          stopStallWatchdog();
          requestStop("stalled");
        }
      }, tick);
      stallTimer.unref?.();
    };

    const cleanup = async () => {
      this.sendCommand = undefined;
      clearTimeout(timeout);
      stopStallWatchdog();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener("abort", onExternalAbort);
      if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
      processHandle?.stdout?.removeAllListeners();
      processHandle?.stderr?.removeAllListeners();
      processHandle?.removeAllListeners();
      if (tempPromptDir) await fs.rm(tempPromptDir, { recursive: true, force: true }).catch(() => {});
      release();
    };

    // Transcript joins are O(transcript) — only attach them on structural
    // updates (message boundaries), not per-chunk live-text ticks.
    const progress = (partial: Partial<TaskResult>, withTranscript = false) => {
      Object.assign(result, partial);
      const checkpoint: Partial<TaskResult> = { ...result, liveText: parser.getLiveText() };
      if (withTranscript) checkpoint.transcript = parser.getTranscript();
      else delete checkpoint.transcript;
      this.onCheckpoint?.(checkpoint);
    };

    /**
     * Budget breach → graceful wrap-up: steer the child to answer NOW and
     * allow `graceTurns` more turns. SIGTERM fires only when grace is
     * exhausted (or configured to 0, or steering is impossible).
     */
    const handleBudgetBreach = (reason: "max_turns" | "max_cost", turns: number) => {
      if (requestedStop || pendingBudgetStop) {
        if (pendingBudgetStop && turns >= pendingBudgetStop.deadlineTurns) requestStop(pendingBudgetStop.reason);
        return;
      }
      const grace = spec.graceTurns ?? this.graceTurns;
      if (grace <= 0 || !this.sendCommand?.({ type: "steer", message: WRAP_UP_MESSAGE })) {
        requestStop(reason);
        return;
      }
      pendingBudgetStop = { reason, deadlineTurns: turns + grace };
    };

    const handleUpdates = (updates: ProtocolUpdate[]) => {
      if (updates.length) {
        lastEventAt = Date.now();
        if (stalledAt !== undefined) {
          stalledAt = undefined;
          result.stalledSince = undefined;
        }
      }
      for (const update of updates) {
        if (update.type === "session") progress({ sessionId: update.sessionId });
        if (update.type === "live-text") progress({ liveText: update.liveText });
        if (update.type === "message") {
          result.messages = parser.getMessages();
          result.usage = update.usage;
          progress({ messages: result.messages, usage: result.usage, liveText: parser.getLiveText() }, true);
          if (pendingBudgetStop) {
            if (update.usage.turns >= pendingBudgetStop.deadlineTurns) requestStop(pendingBudgetStop.reason);
          } else {
            const budget = this.checkBudgets(spec, result.usage);
            if (budget) handleBudgetBreach(budget, update.usage.turns);
          }
        }
        // Headless children cannot answer extension UI dialogs; cancel so the child never hangs.
        if (update.type === "ui-request") this.sendCommand?.({ type: "extension_ui_response", id: update.id, cancelled: true });
        if (update.type === "fatal") {
          fatalError = update.error;
          requestStop("fatal");
        }
        // RPC children stay alive until stdin closes; end it once the run settles.
        if (update.type === "agent-settled") {
          // A settle during the wrap-up window means the child finished its
          // final answer in time.
          if (pendingBudgetStop && !requestedStop) wrappedUp = true;
          try { processHandle?.stdin?.end(); } catch { /* already closed */ }
        }
      }
    };

    const applyTimeoutSemantics = (base: TaskResult): TaskResult => {
      if (requestedStop !== "timeout") return base;
      // Queue timeouts never start work: model them as a clean timeout with phase,
      // not a mysterious execution "failed".
      const phase = timeoutPhase ?? "running";
      return {
        ...base,
        state: "timeout",
        stopReason: "timeout",
        timeoutPhase: phase,
        errorMessage:
          phase === "queued"
            ? "Timed out waiting for a process slot (never started)"
            : phase === "starting"
              ? "Timed out while starting the child process"
              : base.errorMessage || "Timed out while the child was running",
      };
    };

    try {
      if (internal.signal.aborted) {
        result.state = requestedStop === "timeout" ? "timeout" : "cancelled";
        result.stopReason = requestedStop ?? "cancelled";
        result.timeoutPhase = requestedStop === "timeout" ? (timeoutPhase ?? "queued") : undefined;
        result.exitCode = 1;
        result.endedAt = Date.now();
        if (result.state === "timeout" && !result.errorMessage) {
          result.errorMessage = "Timed out waiting for a process slot (never started)";
        }
        return result;
      }

      // Global cap (if configured) is checked before the per-session semaphore so
      // a saturated machine rejects early with a clear message.
      if (this.locks) {
        try {
          globalSlot = this.locks.tryAcquireGlobalSlot(this.runId ?? "anonymous");
        } catch (error: any) {
          result.state = "failed";
          result.stopReason = "global_limit";
          result.errorMessage = error?.message ?? String(error);
          result.exitCode = 1;
          result.endedAt = Date.now();
          return result;
        }
      }

      await this.semaphore.acquire(internal.signal);
      slotHeld = true;
      acquiredAt = Date.now();
      result.acquiredAt = acquiredAt;
      if (internal.signal.aborted) throw new Error("Subagent cancelled before spawn");
      if (abortSignal) {
        abortHandler = () => requestStop("cancelled");
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
      result.state = "running";
      progress({ state: "running", acquiredAt });

      await fs.mkdir(this.sessionDir, { recursive: true });
      if (internal.signal.aborted) throw new Error("Subagent cancelled before spawn");

      const taskBytes = Buffer.byteLength(spec.task, "utf8");
      if (taskBytes > this.maxTaskBytes) {
        throw new Error(
          `Task exceeds maxTaskBytes (${taskBytes} > ${this.maxTaskBytes}). Pass a shorter objective or raise the limit.`,
        );
      }

      // RPC mode keeps a live stdin command channel so steering messages can be
      // injected mid-run. The event stream on stdout is a superset of json mode.
      const args = ["--mode", "rpc", "--session-dir", this.sessionDir];
      if (spec.forkResume && spec.resume) args.push("--fork", spec.resume);
      else if (spec.resume) args.push("--session", spec.resume);
      else if (spec.contextFork) {
        // Context fork: the child starts from a real branched copy of the
        // parent conversation, then receives the task as its next prompt.
        // Fail fast rather than silently degrading to a fresh session.
        if (!spec.parentSessionFile) {
          throw new Error("context:'fork' requires a persisted parent session (none available). Save the session or use context:'fresh'.");
        }
        await fs.access(spec.parentSessionFile).catch(() => {
          throw new Error(`context:'fork' failed: parent session file ${spec.parentSessionFile} is not readable.`);
        });
        args.push("--fork", spec.parentSessionFile);
      }
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
      // Pin the launch identity + depth in env. Children re-register only when
      // depth leaves remaining headroom (enforced in extension + policy too).
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        [DEPTH_ENV_VAR]: String(depth + 1),
      };

      processHandle = spawn(invocation.command, invocation.args, {
        cwd: spec.cwd || process.cwd(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
      spawned = true;

      const pid = processHandle.pid;
      if (pid) {
        childStartTime = processStartTime(pid);
        const identity: ChildProcessIdentity = {
          pid,
          startTime: childStartTime,
          // On POSIX the child is a new process group leader (detached).
          pgid: process.platform === "win32" ? undefined : pid,
          hostname: os.hostname(),
        };
        result.process = identity;
        progress({ process: identity });
        if (this.locks && this.runId) {
          this.locks.writeRunRecord({
            runId: this.runId,
            parentSessionKey: this.parentSessionKey ?? "",
            childSessionId: result.sessionId,
            process: {
              pid: identity.pid,
              startTime: identity.startTime,
              pgid: identity.pgid,
              hostname: identity.hostname ?? os.hostname(),
            },
            startedAt: Date.now(),
            state: "running",
            updatedAt: Date.now(),
          });
        }
      }

      if (requestedStop) requestStop(requestedStop);
      else if (internal.signal.aborted) requestStop("cancelled");

      // Attach readers BEFORE writing stdin so a chatty child cannot fill the
      // OS pipe buffer and deadlock waiting for us to drain.
      processHandle.stdout?.on("data", (chunk: Buffer) => handleUpdates(parser.feed(chunk)));
      processHandle.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-50 * 1024);
        result.stderr = stderr;
      });
      processHandle.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        // EPIPE is expected when a child fails before consuming stdin.
        if (error.code !== "EPIPE") result.errorMessage = `stdin error: ${error.message}`;
      });
      const send = (command: unknown): boolean => {
        const stdin = processHandle?.stdin;
        if (!stdin || !stdin.writable || stdin.destroyed) return false;
        try {
          stdin.write(JSON.stringify(command) + "\n"); // JSONL: LF-delimited, JSON escapes embedded newlines
          return true;
        } catch {
          return false;
        }
      };
      this.sendCommand = send;
      send({ type: "prompt", message: spec.task });
      // RPC mode has no session header line; get_state supplies the session id.
      send({ type: "get_state" });
      lastEventAt = Date.now();
      startStallWatchdog();

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
      // direct Pi process exits normally after a tool backgrounds work — unless
      // the task explicitly opted into keeping backgrounded processes alive.
      if (!spec.keepBackground || requestedStop) forceKillTree();
      const finalized = parser.finalize(closed.code, closed.signal ?? undefined, stderr);
      Object.assign(result, finalized, {
        label: result.label,
        task: spec.task,
        outputFile: spec.output,
        outputMode: spec.outputMode,
        thinking: spec.thinking,
        profile: spec.profile,
        canWrite: spec.canWrite,
        process: result.process,
        startedAt,
        acquiredAt,
        endedAt: Date.now(),
      });

      if (closed.error) {
        result.state = "failed";
        result.stopReason = "spawn_error";
        result.errorMessage = closed.error.message;
      } else if (requestedStop) {
        if (requestedStop === "timeout") {
          Object.assign(result, applyTimeoutSemantics(result));
        } else if (requestedStop === "cancelled") {
          result.state = "cancelled";
          result.stopReason = "cancelled";
          result.exitCode = closed.code;
        } else if (requestedStop === "stalled") {
          // Stall kill is a transient infrastructure failure (retryable), but
          // completed turns still carry useful output.
          result.state = result.usage.turns > 0 ? "partial" : "failed";
          result.stopReason = "stalled";
          result.exitCode = closed.code ?? 1;
          result.stalledSince = stalledAt;
          result.errorMessage = `Child produced no protocol activity for ${Math.round((this.stallAfterMs + this.stallKillAfterMs) / 1000)}s and was stopped`;
        } else if (BUDGET_STOPS.has(requestedStop) && result.usage.turns > 0) {
          result.state = "partial";
          result.stopReason = requestedStop;
          result.exitCode = closed.code;
          result.errorMessage = `Stopped by ${requestedStop.replace("_", " ")} budget after the wrap-up grace period; partial output preserved`;
        } else {
          result.state = "failed";
          result.stopReason = requestedStop === "fatal" ? "error" : requestedStop;
          result.exitCode = closed.code ?? 1;
          if (fatalError) result.errorMessage = fatalError;
        }
      } else if (pendingBudgetStop && (result.state as TaskResult["state"]) === "completed") {
        // Budget breached, but the child wrapped up its final answer within the
        // grace turns: a concluded (if budget-limited) result, not a truncation.
        result.state = "partial";
        result.stopReason = pendingBudgetStop.reason;
        result.wrappedUp = true;
        result.errorMessage = `Reached ${pendingBudgetStop.reason.replace("_", " ")} budget and wrapped up gracefully`;
      }

      if (this.locks && this.runId) {
        this.locks.markRunTerminal(this.runId, result.state);
      }
      return result;
    } catch (error: any) {
      const cancelled = (abortSignal?.aborted && requestedStop !== "timeout") || /cancel/i.test(String(error?.message));
      if (requestedStop === "timeout") {
        result.state = "timeout";
        result.stopReason = "timeout";
        result.timeoutPhase = timeoutPhase ?? (!slotHeld ? "queued" : "running");
        result.errorMessage =
          result.timeoutPhase === "queued"
            ? "Timed out waiting for a process slot (never started)"
            : error?.message ?? "Timed out";
      } else {
        result.state = cancelled ? "cancelled" : "failed";
        result.stopReason = requestedStop ?? (result.state === "cancelled" ? "cancelled" : "error");
        result.errorMessage = error?.message ?? String(error);
      }
      result.exitCode ??= 1;
      result.endedAt = Date.now();
      if (this.locks && this.runId) this.locks.markRunTerminal(this.runId, result.state);
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
    options.locks,
    options.runId,
    options.parentSessionKey,
    options.maxTaskBytes,
    { graceTurns: options.graceTurns, stallAfterMs: options.stallAfterMs, stallKillAfterMs: options.stallKillAfterMs },
  ).run(spec, options.signal);
}
