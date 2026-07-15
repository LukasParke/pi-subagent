import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { defaultConfig, loadConfig, readConfigFile, type SubagentConfig } from "./config.js";
import {
  formatDuration,
  formatStatusPreview,
  formatTokens,
  isActiveState,
  oneLine,
  renderCallLine,
  renderRunLines,
  SPINNERS,
  stateGlyph,
  type InlineRunView,
} from "./format.js";
import { createGetPiCommand, getLaunchResolution } from "./launch.js";
import { abortAsPromise, sweepSessionDir } from "./maintenance.js";
import { runTasks } from "./orchestrator.js";
import { OutputManager } from "./output.js";
import { parseDepth, validateSubagentRequest, type ResolvedTask } from "./policy.js";
import type { ChildRunner } from "./runner.js";
import { ProcessLockManager } from "./process-lock.js";
import { SessionScopedRunRegistry, snapshotFromLiveRun } from "./registry.js";
import { SubagentParamsSchema, type SubagentParams } from "./schema.js";
import { Semaphore } from "./semaphore.js";
import type { RunSnapshot, TaskResult, TaskSpec } from "./types.js";
import { emptyUsage } from "./types.js";
import { buildUsageLedger, formatLedger, type UsageLedger } from "./usage.js";
import { CompletionBatcher, COMPLETION_MESSAGE_TYPE, type CompletionDetails, type CompletionDetailsRun } from "./notifications.js";
import { describeCatalog, discoverAgents, type AgentDefinition } from "./agents.js";
import { createSubagentsOverlay, FooterStatusModel, type SubagentAdapter } from "./ui.js";
import { WorktreeManager } from "./worktree.js";

interface SessionRuntime {
  key: string;
  ctx: ExtensionContext;
  config: SubagentConfig;
  registry: SessionScopedRunRegistry;
  output: OutputManager;
  semaphore: Semaphore;
  worktrees: WorktreeManager;
  locks: ProcessLockManager;
  getPiCommand: ReturnType<typeof createGetPiCommand>;
  /** Live per-run child runners, for mid-run steering. runId → task index → runner. */
  liveRunners: Map<string, Map<number, ChildRunner>>;
  /** Run ids started with async:true — the only runs that notify on completion. */
  asyncRuns: Set<string>;
  completions?: CompletionBatcher;
  widgetTimer?: NodeJS.Timeout;
  /** Named agent catalog (project/shared/global .md files). Refreshed lazily. */
  agents: Map<string, AgentDefinition>;
  agentsLoadedAt: number;
  footer?: FooterStatusModel;
  unsubscribe?: () => void;
  unsubscribeLedger?: () => void;
  pendingRootMessages: import("@earendil-works/pi-ai").Message[];
  /** Memoized usage ledger; recomputed only after usage-affecting events. */
  ledgerValue?: UsageLedger;
  ledgerDirty: boolean;
  closed: boolean;
  depth: number;
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId() || `ephemeral:${ctx.cwd}`;
}

function activeEntries(runtime: SessionRuntime): readonly unknown[] {
  return runtime.ctx.sessionManager.getBranch();
}

/**
 * Ledger computation folds the whole active branch, so it is memoized and
 * invalidated by registry events / new root messages instead of being rebuilt
 * on every footer refresh or live-text tick.
 */
function ledger(runtime: SessionRuntime): UsageLedger {
  if (!runtime.ledgerDirty && runtime.ledgerValue) return runtime.ledgerValue;
  const entries = activeEntries(runtime);
  runtime.ledgerValue = buildUsageLedger(
    entries,
    [
      ...runtime.registry.getLiveRuns(runtime.key).map(snapshotFromLiveRun),
      ...runtime.registry.getSnapshots(runtime.key),
    ],
    runtime.pendingRootMessages,
  );
  runtime.ledgerDirty = false;
  return runtime.ledgerValue;
}

function makeAdapter(runtime: SessionRuntime): SubagentAdapter {
  return {
    getActiveRuns: () => runtime.registry.getLiveRuns(runtime.key).map(snapshotFromLiveRun),
    getCompletedRuns: () => runtime.registry.getSnapshots(runtime.key),
    getRunById(id) {
      const found = runtime.registry.lookup(id, runtime.key);
      if (found.status !== "found" || !found.run) return null;
      return "controller" in found.run ? snapshotFromLiveRun(found.run) : found.run;
    },
    cancelRun(id) {
      const found = runtime.registry.lookup(id, runtime.key);
      if (found.status === "found" && found.run && "controller" in found.run) found.run.controller.abort();
    },
    dismissRun: (id) => { runtime.registry.markDismissed(id, runtime.key); },
    async resumeRun(id) {
      const run = this.getRunById(id);
      const session = run?.results.find((result) => result.sessionId)?.sessionId;
      if (!session) {
        runtime.ctx.ui.notify("No resumable child session is available", "warning");
        return;
      }
      runtime.ctx.ui.setEditorText(`Continue the subagent session ${session}. Ask me for the follow-up task, then use the subagent tool with resume: "${session}".`);
      runtime.ctx.ui.notify("Prepared a resume request in the editor", "info");
    },
    showOutput(id) {
      const run = this.getRunById(id);
      const pointers = run?.results.flatMap((result) => [result.outputFile, result.worktree?.cwd, result.sessionId]).filter(Boolean) as string[] | undefined;
      if (!pointers?.length) runtime.ctx.ui.notify("No output artifact, worktree, or session pointer", "warning");
      else {
        runtime.ctx.ui.setEditorText(pointers.join("\n"));
        runtime.ctx.ui.notify("Output pointers copied to the editor", "info");
      }
    },
    getReadyCount: () => runtime.registry.getSnapshots(runtime.key).filter((run) => !run.delivered).length,
    getUsageSummary: () => formatLedger(ledger(runtime)),
    async steerRun(id) {
      const runners = runtime.liveRunners.get(id) ?? [...runtime.liveRunners.entries()].find(([key]) => key.startsWith(id))?.[1];
      if (!runners?.size) return runtime.ctx.ui.notify("Run has no steerable child (still queued or already finished)", "warning");
      const message = await runtime.ctx.ui.input("Steering message", "guidance for the running child…");
      if (!message?.trim()) return;
      let sent = 0;
      for (const runner of runners.values()) if (runner.steer(message)) sent++;
      runtime.ctx.ui.notify(sent ? `Steering queued for ${sent} task(s); delivered after the current turn` : "Child is no longer accepting input", sent ? "info" : "warning");
    },
    async applyWorktree(id) {
      const run = this.getRunById(id);
      const changed = run?.results.filter((result) => result.worktree?.changed) ?? [];
      if (!changed.length) return runtime.ctx.ui.notify("No changed worktree on this run", "warning");
      if (changed.length > 1) {
        runtime.ctx.ui.setEditorText(`Apply one of the worktrees from run ${id} with the subagent tool: { action: "apply", id: "${id}", index: <task index> }`);
        return runtime.ctx.ui.notify("Multiple changed worktrees; pick one via the tool (prompt prepared)", "info");
      }
      const tree = changed[0]!.worktree!;
      const ok = await runtime.ctx.ui.confirm("Apply worktree changes?", `Applies branch ${tree.branch} onto ${runtime.ctx.cwd} as uncommitted changes.`);
      if (!ok) return;
      try {
        const applied = await runtime.worktrees.apply({ cwd: tree.cwd, baseCommit: tree.baseCommit }, runtime.ctx.cwd);
        runtime.ctx.ui.notify(applied.applied ? `Applied: ${applied.stat.split("\n").pop() ?? "changes staged in working tree"}` : "No changes to apply", "info");
      } catch (error: any) {
        runtime.ctx.ui.notify(`Apply failed: ${error?.message ?? error}`, "error");
      }
    },
    async discardWorktree(id) {
      const run = this.getRunById(id);
      const changed = run?.results.filter((result) => result.worktree?.changed) ?? [];
      if (!changed.length) return runtime.ctx.ui.notify("No changed worktree on this run", "warning");
      const ok = await runtime.ctx.ui.confirm(
        "Discard worktree(s)?",
        `Permanently deletes ${changed.length} worktree(s) and branch(es): ${changed.map((result) => result.worktree!.branch).join(", ")}`,
      );
      if (!ok) return;
      for (const result of changed) {
        const tree = result.worktree!;
        await runtime.worktrees.forceRemove({ cwd: tree.cwd, branch: tree.branch, baseCwd: runtime.ctx.cwd, baseCommit: tree.baseCommit, changed: true }).catch(() => {});
      }
      runtime.ctx.ui.notify(`Discarded ${changed.length} worktree(s)`, "info");
    },
    subscribe: (listener) => runtime.registry.subscribe((event) => {
      if (event.sessionKey === runtime.key) listener();
    }),
    notify(message, level = "info") {
      runtime.ctx.ui.notify(message, level === "warn" ? "warning" : level);
    },
  };
}

function refreshFooter(runtime: SessionRuntime): void {
  if (runtime.closed || !runtime.footer) return;
  const active = runtime.registry.getLiveRuns(runtime.key).length;
  runtime.footer.update(active);
  // Terse and actionable only: Pi's native footer already reports session cost.
  const text = runtime.footer.render(runtime.ctx.ui.theme);
  runtime.ctx.ui.setStatus("subagent", text || undefined);
  refreshWidget(runtime);
}

/**
 * Ambient widget above the editor for BACKGROUND runs only — foreground runs
 * already render inline as the tool result, so showing them here would
 * double-render. Cleared when no background runs are live.
 */
function refreshWidget(runtime: SessionRuntime): void {
  if (runtime.closed || !runtime.ctx.hasUI) return;
  const theme = runtime.ctx.ui.theme;
  const live = runtime.registry.getLiveRuns(runtime.key).filter((run) => runtime.asyncRuns.has(run.id));
  if (!live.length) {
    runtime.ctx.ui.setWidget("subagent", undefined);
    if (runtime.widgetTimer) {
      clearInterval(runtime.widgetTimer);
      runtime.widgetTimer = undefined;
    }
    return;
  }
  // Animate spinner/elapsed even when the child is between events.
  if (!runtime.widgetTimer) {
    runtime.widgetTimer = setInterval(() => refreshWidget(runtime), 250);
    runtime.widgetTimer.unref?.();
  }
  const now = Date.now();
  const frame = Math.floor(now / 120) % SPINNERS.length;
  const lines: string[] = [theme.fg("accent", "●") + " " + theme.bold("Subagents")];
  const shown = live.slice(0, 4);
  shown.forEach((run, index) => {
    const last = index === shown.length - 1 && live.length <= 4;
    const joint = last ? "└─" : "├─";
    for (const result of run.results.slice(0, 2)) {
      const active = isActiveState(result.state);
      const glyph = active ? theme.fg("accent", SPINNERS[frame]!) : stateGlyph(result.state, theme);
      const stats = [
        result.usage.turns ? `↻${result.usage.turns}` : "",
        result.usage.input + result.usage.output ? `${formatTokens(result.usage.input + result.usage.output)} tok` : "",
        formatDuration(now - run.startedAt),
      ].filter(Boolean).join(" · ");
      const activity = result.liveText?.split("\n").reverse().find((line) => line.trim());
      lines.push(`${theme.fg("dim", joint)} ${glyph} ${theme.fg("text", result.label)} ${theme.fg("dim", `· ${stats}`)}`);
      if (activity) lines.push(`${theme.fg("dim", last ? "    " : "│   ")}${theme.fg("dim", "⎿ ")}${theme.fg("muted", oneLine(activity, 80))}`);
    }
  });
  if (live.length > 4) lines.push(theme.fg("dim", `└─ +${live.length - 4} more · /subagents`));
  runtime.ctx.ui.setWidget("subagent", lines);
}

function utf8Preview(value: unknown, maxBytes: number): string {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

interface RunMeta {
  state?: RunSnapshot["state"];
  startedAt?: number;
  endedAt?: number;
}

function compactDetails(
  mode: "single" | "parallel",
  results: Array<TaskResult | RunSnapshot["results"][number]>,
  maxDetailsTextBytes = defaultConfig.maxDetailsTextBytes,
  run?: RunMeta,
) {
  const perResultText = Math.max(256, Math.floor(maxDetailsTextBytes / Math.max(1, results.length) / 2));
  return {
    mode,
    state: run?.state,
    startedAt: run?.startedAt,
    endedAt: run?.endedAt,
    results: results.map((result: any) => ({
      label: result.label,
      task: String(result.task ?? "").slice(0, 500),
      state: result.state,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      timeoutPhase: result.timeoutPhase,
      errorMessage: result.errorMessage?.slice(0, 1_000),
      usage: result.usage ?? emptyUsage(),
      model: result.model,
      thinking: result.thinking,
      profile: result.profile,
      canWrite: result.canWrite,
      outputFile: result.outputFile,
      outputMode: result.outputMode,
      worktree: result.worktree,
      sessionId: result.sessionId,
      process: result.process,
      finalOutput: utf8Preview(result.finalOutput ?? result.liveText, perResultText),
      transcript: utf8Preview(result.transcript, perResultText),
      wrappedUp: result.wrappedUp,
      stalledSince: result.stalledSince,
      attempts: result.attempts,
      attemptedModels: result.attemptedModels,
      structuredOutput: result.structuredOutput,
      structuredError: result.structuredError,
    })),
  };
}

/** Minimal component for message renderers (fresh per render; no reuse contract). */
function lineComponentForMessage(render: (width: number) => string[]): Component {
  return { render, invalidate() {} };
}

/** Reusable one-shot component: stable identity across renders, content swapped in place. */
class LineBlock implements Component {
  private fn: (width: number) => string[] = () => [];
  set(fn: (width: number) => string[]): void { this.fn = fn; }
  render(width: number): string[] { return this.fn(width); }
  invalidate(): void {}
}

/**
 * Wall-clock spinner frame. While a foreground run streams, Pi's working
 * indicator keeps the TUI repainting, so deriving the frame from time inside
 * the render closure animates smoothly without owning any timer.
 */
function liveSpinnerFrame(): number {
  return Math.floor(Date.now() / 100) % SPINNERS.length;
}

// keyHint lives in the coding-agent runtime; load it lazily on first render so
// headless children never pay for Pi's provider/network stack at startup.
let keyHintFn: ((id: string, description: string) => string) | null | undefined;
function expandHint(): string {
  if (keyHintFn === undefined) {
    keyHintFn = null;
    void import("@earendil-works/pi-coding-agent")
      .then((m: any) => { keyHintFn = typeof m.keyHint === "function" ? m.keyHint : null; })
      .catch(() => { keyHintFn = null; });
  }
  try {
    return keyHintFn ? keyHintFn("app.tools.expand", "to expand") : "ctrl+o to expand";
  } catch {
    return "ctrl+o to expand";
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/** Re-read agent files at most every few seconds; they can change mid-session. */
function agentCatalog(runtime: SessionRuntime): Map<string, AgentDefinition> {
  const now = Date.now();
  if (now - runtime.agentsLoadedAt > 5_000) {
    runtime.agents = discoverAgents(runtime.ctx.cwd);
    runtime.agentsLoadedAt = now;
  }
  return runtime.agents;
}

function guidelines(catalog?: Map<string, AgentDefinition>): string[] {
  const agentLines = catalog?.size
    ? [
        "Named agents available via agent:'<name>' (persona prompt + defaults; explicit params still override):",
        ...describeCatalog(catalog).map((line) => `  - ${line}`),
      ]
    : [];
  return [
    ...agentLines,
    "Delegate independent, read-heavy exploration or clean-context review; keep tightly coupled work in the parent.",
    "Prefer agent:'<name>' when a named agent matches the task — its persona prompt is usually better than an improvised one. Compose fields manually only when no agent fits.",
    "Give every task a short description label (3-5 words) so runs are scannable in UIs and result indexes.",
    "Profiles: explore/review are strictly read-only (safe for fanout); general inherits the parent's active tools and may write. Single tasks default to general, parallel tasks to explore.",
    "Parallel writers need isolation:'worktree' (each gets an isolated checkout; changed work lands on a branch). After a worktree run finishes, use action:'diff' to inspect, then 'apply' to bring changes into the main checkout or 'discard' to drop them.",
    "Set budgets: at max_turns/max_cost the child is steered to wrap up and given grace turns for a final answer (grace_turns tunes this); results end as 'partial' with wrappedUp:true when the child concluded. timeout_ms includes queue time; timeout results report the phase.",
    "Transient failures (provider errors, stalls, queue timeouts) retry automatically; pass fallback_models:['…'] to escalate models across attempts. Task-quality failures never retry.",
    "context:'fork' starts a single child from a branched copy of this conversation — use it when the task depends on discussion context instead of re-explaining. Single-task only.",
    "Use async:true only when you have independent work meanwhile; then use action:'wait' with the run id (interruptible, does not cancel). action:'steer' injects mid-run guidance into a running child instead of cancel + retry.",
    "For parallel research, add synthesis:'<instruction>' to have one read-only child fold all outputs into a single brief, delivered first.",
    "Use output_schema (JSON Schema) when you need a machine-readable result: the child must end with a validated json:result block, invalid output gets one automatic repair round, and delivery is the clean JSON. Compose downstream steps from details.results[].structuredOutput.",
    "Use output_mode:'file-only' for large reports; the parent gets a pointer instead of inline text.",
    "resume:'<child session id>' continues a finished child with context intact; fork_resume:true branches it instead.",
  ];
}

/**
 * Fan-in step for parallel runs: one read-only child folds the per-task
 * outputs into a single brief. Best effort — returns undefined on any failure
 * so the raw results still deliver.
 */
async function runSynthesis(
  runtime: SessionRuntime,
  instruction: string,
  results: TaskResult[],
  options: { runId: string; model?: string; signal: AbortSignal },
): Promise<TaskResult | undefined> {
  const sections = results.map((result, index) => {
    // Typed handoff: validated structured results feed the synthesis child
    // clean JSON instead of prose tails.
    if (result.structuredOutput !== undefined) {
      const json = JSON.stringify(result.structuredOutput, null, 2).slice(0, 12_000);
      return `## Task ${index + 1}: ${result.label} [${result.state}] (validated structured result)\n\n\`\`\`json\n${json}\n\`\`\``;
    }
    const raw = result.liveText ?? result.errorMessage ?? "(no output)";
    const capped = raw.length > 12_000;
    const body = capped
      ? `${raw.slice(0, 12_000)}\n[… truncated ${raw.length - 12_000} chars; ${result.outputFile ? `full output: ${result.outputFile}` : "full output in the child session"}]`
      : raw;
    const invalid = result.structuredError ? `\n[structured output FAILED validation: ${result.structuredError}]` : "";
    const pointer = result.outputFile ? `\nFull output file: ${result.outputFile}` : "";
    return `## Task ${index + 1}: ${result.label} [${result.state}]${pointer}${invalid}\n\n${body}`;
  });
  const anyTruncated = results.some((result) => result.structuredOutput === undefined && (result.liveText ?? result.errorMessage ?? "").length > 12_000);
  const task = [
    "You are a synthesis agent. Fold the following subagent task outputs into one coherent brief.",
    `Instruction: ${instruction}`,
    "Report conflicts between tasks explicitly. Do not invent findings that no task produced.",
    anyTruncated
      ? "Some task outputs below are TRUNCATED samples — read the referenced full output files before drawing conclusions that depend on completeness, and flag any conclusion based on a truncated section."
      : "",
    "",
    ...sections,
  ].filter(Boolean).join("\n\n");
  try {
    const { runSubagent } = await import("./runner.js");
    const synth = await runSubagent(
      {
        task,
        label: "synthesis",
        profile: "review",
        canWrite: false,
        tools: ["read"],
        model: options.model,
        thinking: "low",
        timeoutMs: Math.min(runtime.config.defaultTimeoutMs, 5 * 60_000),
        maxTurns: 8,
      },
      {
        semaphore: runtime.semaphore,
        getPiCommand: runtime.getPiCommand,
        sessionDir: runtime.config.sessionDir,
        killGraceMs: runtime.config.killGraceMs,
        locks: runtime.locks,
        runId: `${options.runId}:synthesis`,
        parentSessionKey: runtime.key,
        signal: options.signal,
      },
    );
    if (synth.state !== "completed" && synth.state !== "partial") return undefined;
    synth.label = "synthesis";
    return synth;
  } catch {
    return undefined;
  }
}

/** Compact completion payload for notification messages (LLM + renderer facing). */
function buildCompletionDetails(runtime: SessionRuntime, runIds: string[]): CompletionDetails {
  const runs: CompletionDetailsRun[] = [];
  for (const id of runIds) {
    const found = runtime.registry.lookup(id, runtime.key);
    if (found.status !== "found" || !found.run || "controller" in found.run) continue;
    const snapshot = found.run;
    let turns = 0, tokens = 0, cost = 0;
    const pointers: string[] = [];
    for (const result of snapshot.results) {
      turns += result.usage?.turns ?? 0;
      tokens += (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
      cost += result.usage?.cost ?? 0;
      if (result.outputFile) pointers.push(result.outputFile);
      if (result.worktree?.changed) pointers.push(`branch ${result.worktree.branch}`);
    }
    const first = snapshot.results[0];
    const preview = oneLine(
      (first?.finalOutput ?? first?.errorMessage ?? snapshot.summary ?? "").split("\n").find((line) => line.trim()) ?? "",
      100,
    );
    runs.push({
      id: snapshot.id,
      label: first?.label ?? snapshot.taskPreviews[0] ?? "task",
      state: snapshot.state,
      preview,
      turns,
      tokens,
      cost,
      durationMs: (snapshot.endedAt ?? Date.now()) - snapshot.startedAt,
      pointers,
    });
  }
  return { runs };
}

/**
 * Fire-and-forget startup GC + orphan reclaim.
 * Only top-level parents may run maintenance — nested children would race each
 * other and could operate on worktrees still owned by a concurrent parent.
 */
function scheduleMaintenance(runtime: SessionRuntime): void {
  if (runtime.depth > 0) return;
  void (async () => {
    // Reconcile orphans first so "lost" is an honest fact before any resume.
    const reaped = await runtime.locks.reconcileOrphans({
      killGraceMs: runtime.config.killGraceMs,
      parentSessionKey: runtime.key,
      skipRunIds: new Set(runtime.registry.getLiveRuns(runtime.key).map((run) => run.id)),
    });
    for (const id of [...reaped.reaped, ...reaped.alreadyDead]) {
      runtime.registry.clearResumeBlock(id, runtime.key);
    }
    runtime.locks.sweep((runtime.config.lockRetentionDays ?? 7) * 24 * 60 * 60_000);

    const keep = new Set(runtime.registry.planSessionRetention().keep);
    await sweepSessionDir(runtime.config.sessionDir, keep, runtime.config.sessionRetentionDays ?? 0);
    const liveWorktrees = runtime.registry.getLiveWorktreeCwds(runtime.key);
    await runtime.worktrees.sweep(runtime.ctx.cwd, runtime.config.worktreeRetentionDays, liveWorktrees);
  })().catch(() => { /* maintenance is best effort */ });
}

export default function registerSubagent(pi: ExtensionAPI): void {
  let current: SessionRuntime | undefined;

  // Fail-closed depth parse (malformed env) walks past any plausible ceiling so we
  // skip registering the tool entirely in scrubbed/forged-depth child processes.
  // Normal nested children still register; execute-time validation + the runtime
  // config maxDepth are the real limit (file-configured caps need session_start).
  const bootDepth = parseDepth();
  if (bootDepth >= 100) return;

  async function teardown(runtime: SessionRuntime): Promise<void> {
    if (runtime.closed) return;
    await runtime.registry.shutdown(runtime.key, 8_000);
    runtime.closed = true;
    runtime.unsubscribe?.();
    runtime.unsubscribeLedger?.();
    runtime.completions?.dispose();
    runtime.footer?.dispose();
    runtime.locks.dispose();
    if (runtime.widgetTimer) clearInterval(runtime.widgetTimer);
    runtime.ctx.ui.setStatus("subagent", undefined);
    runtime.ctx.ui.setWidget("subagent", undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (current && !current.closed) await teardown(current);
    const runtime = {} as SessionRuntime;
    runtime.key = sessionKey(ctx);
    runtime.ctx = ctx;
    runtime.config = loadConfig(await readConfigFile());
    runtime.depth = parseDepth();
    runtime.output = new OutputManager(runtime.config);
    runtime.semaphore = new Semaphore(runtime.config.maxActiveProcesses, runtime.config.maxQueuedTasks);
    runtime.worktrees = new WorktreeManager(undefined, runtime.config.worktreeDir);
    runtime.locks = new ProcessLockManager({
      rootDir: runtime.config.lockDir,
      maxGlobalActive: runtime.config.maxGlobalActive,
    });
    runtime.getPiCommand = createGetPiCommand(getLaunchResolution());
    runtime.liveRunners = new Map();
    runtime.asyncRuns = new Set();
    runtime.agents = discoverAgents(ctx.cwd);
    runtime.agentsLoadedAt = Date.now();
    runtime.pendingRootMessages = [];
    runtime.ledgerDirty = true;
    runtime.closed = false;
    runtime.registry = new SessionScopedRunRegistry(runtime.config, {
      getEntries: () => ctx.sessionManager.getBranch() as any[],
      appendEntry: (type, data) => {
        // Captured runtime ownership prevents an old async callback from appending to a new session.
        if (current !== runtime || runtime.closed || sessionKey(ctx) !== runtime.key) return;
        pi.appendEntry(type, data);
      },
    }, runtime.locks);
    runtime.unsubscribeLedger = runtime.registry.subscribe((event) => {
      if (event.sessionKey === runtime.key) runtime.ledgerDirty = true;
    });
    // Background-run completion notifications: batched followUp messages so
    // the parent LLM reacts without polling. Foreground runs deliver inline.
    runtime.completions = new CompletionBatcher((runIds) => {
      if (current !== runtime || runtime.closed) return;
      // Delivered-state is re-checked at flush time: a wait that consumed the
      // run during the batching window suppresses the redundant notification.
      const undelivered = runIds.filter((id) => {
        const found = runtime.registry.lookup(id, runtime.key);
        return found.status === "found" && !!found.run && !found.run.delivered;
      });
      const details = buildCompletionDetails(runtime, undelivered);
      if (!details.runs.length) return;
      const lines = details.runs.map((run) =>
        `- [${run.id.slice(0, 8)}] ${run.label}: ${run.state}${run.preview ? ` — ${run.preview}` : ""}${run.pointers.length ? ` (${run.pointers.join(", ")})` : ""}`);
      pi.sendMessage({
        customType: COMPLETION_MESSAGE_TYPE,
        content: [
          `${details.runs.length === 1 ? "A background subagent run" : `${details.runs.length} background subagent runs`} finished:`,
          ...lines,
          `Use { action: "wait", id } to collect full output, or dismiss with status if not needed.`,
        ].join("\n"),
        display: true,
        details,
      }, { deliverAs: "followUp", triggerTurn: true });
    });
    runtime.unsubscribe = runtime.registry.subscribe((event) => {
      if (event.sessionKey !== runtime.key) return;
      if (event.type === "terminal" && runtime.asyncRuns.has(event.runId)) {
        runtime.asyncRuns.delete(event.runId);
        // Delivered-state is checked again at flush time (wait may consume the
        // run during the batching window).
        runtime.completions?.add(event.runId, !["completed", "partial"].includes(event.state));
      }
      if (ctx.hasUI && event.type === "terminal") {
        runtime.footer?.notifyTerminal(
          event.runId,
          `Subagent ${event.runId.slice(0, 8)} ${event.state}`,
          event.state === "completed" ? "info" : "warn",
        );
      }
      refreshFooter(runtime);
    });
    if (ctx.hasUI) {
      runtime.footer = new FooterStatusModel(makeAdapter(runtime));
      runtime.footer.setOnUpdate(() => refreshFooter(runtime));
    }
    current = runtime;
    refreshFooter(runtime);
    scheduleMaintenance(runtime);
  });

  pi.on("message_end", async (event) => {
    const runtime = current;
    if (!runtime || runtime.closed || event.message.role !== "assistant") return;
    // Supplement immediately; ledger deduplicates when SessionManager exposes it.
    runtime.pendingRootMessages.push(event.message);
    if (runtime.pendingRootMessages.length > 20) runtime.pendingRootMessages.shift();
    runtime.ledgerDirty = true;
    refreshFooter(runtime);
  });

  pi.on("session_before_tree", async () => {
    const runtime = current;
    if (!runtime || runtime.closed) return;
    // Finish persistence on the originating leaf before Pi moves the branch pointer.
    await runtime.registry.shutdown(runtime.key, 8_000);
  });

  pi.on("session_tree", async () => {
    const runtime = current;
    if (!runtime || runtime.closed) return;
    runtime.pendingRootMessages = [];
    runtime.ledgerDirty = true;
    runtime.registry.refreshSnapshots(runtime.key);
    refreshFooter(runtime);
  });

  pi.on("session_shutdown", async () => {
    const runtime = current;
    if (!runtime) return;
    // Keep ownership valid until cancellation, process close, and final persistence finish.
    await teardown(runtime);
    if (current === runtime) current = undefined;
  });

  // Themed completion box for background-run notifications; the LLM sees the
  // plain content, the human sees this.
  pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as CompletionDetails | undefined;
    if (!details?.runs.length) return undefined;
    return lineComponentForMessage((width) => {
      const lines: string[] = [];
      for (const run of details.runs) {
        const glyph = stateGlyph(run.state as any, theme);
        const stats = [
          run.turns ? `↻${run.turns}` : "",
          run.tokens ? `${formatTokens(run.tokens)} tok` : "",
          run.cost > 0.00005 ? `$${run.cost.toFixed(3)}` : "",
          formatDuration(run.durationMs),
        ].filter(Boolean).join(" · ");
        lines.push(truncateToWidth(`${glyph} ${theme.bold(theme.fg("toolTitle", run.label))} ${theme.fg("dim", `[${run.id.slice(0, 8)}] ${stats}`)}`, width));
        if (run.preview) lines.push(truncateToWidth(`  ${theme.fg("dim", "⎿")} ${theme.fg("toolOutput", run.preview)}`, width));
        if ((expanded || details.runs.length === 1) && run.pointers.length) {
          lines.push(truncateToWidth(theme.fg("dim", `  ${run.pointers.join(" · ")}`), width));
        }
      }
      lines.push(theme.fg("dim", truncateToWidth(`wait { id } collects full output`, width)));
      return lines;
    });
  });

  pi.registerCommand("subagent-cost", {
    description: "Show parent / subagent / combined usage for this branch",
    handler: async (_args, ctx) => {
      const runtime = current;
      if (!runtime || runtime.key !== sessionKey(ctx)) return ctx.ui.notify("Subagent runtime is not ready", "error");
      ctx.ui.notify(formatLedger(ledger(runtime)), "info");
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect subagent runs, artifacts, sessions, and combined usage",
    handler: async (_args, ctx) => {
      const runtime = current;
      if (!runtime || runtime.key !== sessionKey(ctx)) return ctx.ui.notify("Subagent runtime is not ready", "error");
      await ctx.ui.custom(
        (tui: TUI, theme: Theme, _keybindings, done) => createSubagentsOverlay(tui, theme, makeAdapter(runtime), () => done(undefined)),
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
      );
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run isolated Pi subagents in foreground, parallel, or cancellable background mode.",
    // Guidelines are baked into the system prompt at registration (extension
    // load runs per-session in the project cwd). Agents added mid-session are
    // usable immediately via agent:'name' (execute-time refresh); only the
    // system-prompt advertisement waits for the next session.
    promptGuidelines: guidelines(discoverAgents(process.cwd())),
    parameters: SubagentParamsSchema,
    async execute(_id, params: SubagentParams, signal, onUpdate, ctx) {
      const runtime = current;
      if (!runtime || runtime.closed || runtime.key !== sessionKey(ctx)) {
        fail("Subagent runtime is not initialized for this session.");
      }
      if (!Value.Check(SubagentParamsSchema, params)) {
        const errors = [...Value.Errors(SubagentParamsSchema, params)].slice(0, 5).map((error: any) => error.message).join("; ");
        fail(`Invalid parameters: ${errors}`);
      }

      const model = ctx.model;
      const validated = validateSubagentRequest(params, {
        cwd: ctx.cwd,
        model: model ? `${model.provider}/${model.id}` : undefined,
        thinking: pi.getThinkingLevel() as TaskSpec["thinking"],
        availableTools: pi.getAllTools().map((tool) => tool.name),
        activeTools: pi.getActiveTools(),
        depth: parseDepth(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      }, {
        maxDepth: runtime.config.maxDepth,
        maxTasks: runtime.config.maxTasksPerRun,
        defaultTimeoutMs: runtime.config.defaultTimeoutMs,
        taskDefaults: runtime.config.taskDefaults,
        agents: agentCatalog(runtime),
      });
      if (!validated.ok) fail(validated.error);

      const details = (mode: "single" | "parallel", results: Array<TaskResult | RunSnapshot["results"][number]>, run?: RunMeta) =>
        compactDetails(mode, results, runtime.config.maxDetailsTextBytes, run);

      if (["status", "wait", "cancel", "steer", "diff", "apply", "discard"].includes(validated.mode)) {
        if (validated.mode === "status" && !validated.id) {
          const runs = [
            ...runtime.registry.getLiveRuns(runtime.key).map(snapshotFromLiveRun),
            ...runtime.registry.getSnapshots(runtime.key),
          ];
          const catalog = agentCatalog(runtime);
          const agentSection = catalog.size
            ? `Named agents (use agent:'<name>'):\n${describeCatalog(catalog).map((line) => `- ${line}`).join("\n")}`
            : "";
          const text = [
            runs.length ? runs.map((run) => formatStatusPreview(run)).join("\n") : "No subagent runs.",
            agentSection,
            formatLedger(ledger(runtime)),
          ].filter(Boolean).join("\n\n");
          return { content: [{ type: "text", text }], details: details("single", []) };
        }
        const found = runtime.registry.lookup(validated.id!, runtime.key);
        if (found.status === "ambiguous") fail(`Ambiguous id. Matches: ${found.matches!.join(", ")}`);
        if (found.status !== "found" || !found.run) fail(`Run ${validated.id} was not found in this session.`);
        const snapshot = "controller" in found.run ? snapshotFromLiveRun(found.run) : found.run;
        if (validated.mode === "status") {
          return { content: [{ type: "text", text: `${formatStatusPreview(snapshot)}\n${formatLedger(ledger(runtime))}` }], details: details(snapshot.mode, snapshot.results, snapshot) };
        }
        if (validated.mode === "cancel") {
          if ("controller" in found.run) found.run.controller.abort();
          return { content: [{ type: "text", text: `Cancellation requested for ${snapshot.id}` }], details: details(snapshot.mode, snapshot.results, snapshot) };
        }
        if (validated.mode === "steer") {
          if (!("controller" in found.run)) fail(`Run ${snapshot.id} is not running; steer only applies to live runs. Use resume to continue a finished child.`);
          const runners = runtime.liveRunners.get(snapshot.id);
          if (!runners?.size) fail(`Run ${snapshot.id} has no steerable child yet (still queued or starting). Retry in a moment.`);
          const eligible = validated.index !== undefined
            ? runners.get(validated.index) ? [[validated.index, runners.get(validated.index)!] as const] : []
            : [...runners.entries()];
          if (!eligible.length) fail(`No live task at index ${validated.index} in run ${snapshot.id}. Live indexes: ${[...runners.keys()].join(", ")}`);
          if (validated.index === undefined && eligible.length > 1) {
            fail(`Run ${snapshot.id} has ${eligible.length} live tasks; pass index to pick one (live indexes: ${[...runners.keys()].join(", ")}).`);
          }
          const [index, runner] = eligible[0]!;
          if (!runner.steer(validated.message!)) fail(`Task ${index} in run ${snapshot.id} is no longer accepting input.`);
          return {
            content: [{ type: "text", text: `Steering message queued for run ${snapshot.id} task ${index}. It is delivered after the current assistant turn; watch status/wait for the response.` }],
            details: details(snapshot.mode, snapshot.results, snapshot),
          };
        }
        if (["diff", "apply", "discard"].includes(validated.mode)) {
          if ("controller" in found.run) fail(`Run ${snapshot.id} is still running; worktree actions apply to finished runs.`);
          const withTrees = snapshot.results
            .map((result, index) => ({ result, index }))
            .filter((entry) => entry.result.worktree?.changed);
          if (!withTrees.length) fail(`Run ${snapshot.id} has no changed worktrees.`);
          const chosen = validated.index !== undefined
            ? withTrees.find((entry) => entry.index === validated.index)
            : withTrees.length === 1 ? withTrees[0] : undefined;
          if (!chosen) {
            fail(`Run ${snapshot.id} has ${withTrees.length} changed worktrees; pass index to pick one (indexes: ${withTrees.map((entry) => entry.index).join(", ")}).`);
          }
          const tree = chosen.result.worktree!;
          if (validated.mode === "diff") {
            const diff = await runtime.worktrees.diff({ cwd: tree.cwd, baseCommit: tree.baseCommit });
            const text = [
              `Worktree diff for run ${snapshot.id} task ${chosen.index} (branch ${tree.branch}):`,
              diff.stat || "(no stat)",
              "",
              diff.patch || "(no patch)",
              diff.truncated ? `\n[patch truncated; full diff: git -C ${tree.cwd} diff ${tree.baseCommit}]` : "",
            ].filter(Boolean).join("\n");
            const capped = runtime.output.capOutputForDelivery([{ ...chosen.result, finalOutput: text, outputMode: "inline" }] as any);
            return { content: [{ type: "text", text: capped.text }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          if (validated.mode === "apply") {
            const applied = await runtime.worktrees.apply({ cwd: tree.cwd, baseCommit: tree.baseCommit }, ctx.cwd);
            const text = applied.applied
              ? `Applied worktree changes from run ${snapshot.id} task ${chosen.index} into ${ctx.cwd} as uncommitted working-tree changes:\n${applied.stat}\nReview and commit them. The worktree and branch ${tree.branch} are preserved; use action:'discard' to clean up.`
              : `Worktree for run ${snapshot.id} task ${chosen.index} had no changes to apply.`;
            return { content: [{ type: "text", text }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          // discard
          await runtime.worktrees.forceRemove({ cwd: tree.cwd, branch: tree.branch, baseCwd: ctx.cwd, baseCommit: tree.baseCommit, changed: tree.changed });
          return { content: [{ type: "text", text: `Discarded worktree and branch ${tree.branch} from run ${snapshot.id} task ${chosen.index}.` }], details: details(snapshot.mode, snapshot.results, snapshot) };
        }
        if ("promise" in found.run) {
          // Wait must stay interruptible: aborting the wait returns promptly
          // WITHOUT cancelling the background run (that is cancel's job).
          const settled = found.run.promise.then(() => "done" as const, () => "done" as const);
          const raced = await Promise.race([settled, abortAsPromise(signal) ?? settled]);
          if (raced === "aborted") {
            return {
              content: [{ type: "text", text: `Wait aborted. Run ${snapshot.id} continues in the background; use status/wait/cancel later or open /subagents.` }],
              details: details(snapshot.mode, snapshot.results, snapshot),
            };
          }
        }
        const refreshed = runtime.registry.lookup(snapshot.id, runtime.key);
        const terminal = refreshed.status === "found" && refreshed.run
          ? "controller" in refreshed.run ? snapshotFromLiveRun(refreshed.run) : refreshed.run
          : snapshot;
        if (!runtime.registry.markDelivered(terminal.id, runtime.key)) {
          return { content: [{ type: "text", text: `Run ${terminal.id} was already delivered. Artifacts and sessions remain available in /subagents.` }], details: details(terminal.mode, terminal.results, terminal) };
        }
        const delivered = runtime.output.capOutputForDelivery(terminal.results);
        const text = delivered.text || terminal.summary || "(no output)";
        // Locate runs and partial/timeout deliveries still return content; hard
        // failures and “lost with resume blocked” raise so the agent notices.
        if (terminal.state === "failed" || terminal.state === "lost") fail(text);
        return { content: [{ type: "text", text }], details: details(terminal.mode, delivered.cappedResults as any, terminal) };
      }

      const specs: TaskSpec[] = validated.tasks.map((task: ResolvedTask) => ({
        task: task.task,
        label: task.label,
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.effectiveTools,
        profile: task.profile,
        canWrite: task.canWrite,
        cwd: task.cwd,
        timeoutMs: task.timeoutMs,
        maxTurns: task.maxTurns,
        maxCost: task.maxCost,
        output: task.output,
        outputMode: task.outputMode,
        outputSchema: task.outputSchema,
        resume: task.resume,
        forkResume: task.forkResume,
        isolation: task.isolation,
        allowSharedWrites: task.allowSharedWrites,
        keepBackground: task.keepBackground,
        graceTurns: task.graceTurns,
        fallbackModels: task.fallbackModels,
        maxRetries: task.maxRetries,
        contextFork: task.contextFork,
        parentSessionFile: task.parentSessionFile,
      }));
      const runId = runtime.registry.allocateRunId();
      const directResumes = validated.tasks.filter((task) => task.resume && !task.forkResume).map((task) => task.resume!);
      const lock = runtime.registry.acquireResumeLocks(directResumes, runId, runtime.key);
      if (!lock.ok) fail(`Child session ${lock.conflict!.sessionId} is already active in run ${lock.conflict!.runId}. Use fork_resume:true for an independent continuation.`);

      const controller = new AbortController();
      const parentAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", parentAbort, { once: true });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      try {
        runtime.registry.start(runtime.key, validated.mode as "single" | "parallel", specs, controller, done, validated.tasks.map((task) => task.label), runId);
      } catch (error) {
        for (const session of directResumes) runtime.registry.releaseResumeLock(session, runtime.key, runId);
        throw error;
      }

      // Throttle streamed tool updates with a trailing-edge flush: structural
      // changes (state transition, new session id, billed turn) emit
      // immediately; live-text ticks coalesce into at most one deferred emit
      // per window, so the final state of a burst always renders. Runner
      // checkpoints spread the full result, so "structural" is detected by
      // diffing against the last seen values per task index.
      let lastStreamedUpdate = 0;
      let pendingFlush: NodeJS.Timeout | undefined;
      const lastSeen = new Map<number, { state?: string; sessionId?: string; turns: number }>();
      const emitUpdate = () => {
        if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = undefined; }
        lastStreamedUpdate = Date.now();
        const live = runtime.registry.lookup(runId, runtime.key);
        if (live.status !== "found" || !live.run) return;
        const snap = "controller" in live.run ? snapshotFromLiveRun(live.run) : live.run;
        // content stays compact and stable (LLM-facing); details carries the
        // frequently-updated render data (state, usage, live-text tail).
        onUpdate?.({ content: [{ type: "text", text: formatStatusPreview(snap) }], details: details(snap.mode, snap.results, snap) });
      };
      const streamUpdate = (index: number, partial: Partial<TaskResult>) => {
        const seen = lastSeen.get(index) ?? { turns: 0 };
        const structural =
          (partial.state !== undefined && partial.state !== seen.state) ||
          (partial.sessionId !== undefined && partial.sessionId !== seen.sessionId) ||
          (partial.usage !== undefined && partial.usage.turns > seen.turns);
        lastSeen.set(index, {
          state: partial.state ?? seen.state,
          sessionId: partial.sessionId ?? seen.sessionId,
          turns: Math.max(seen.turns, partial.usage?.turns ?? 0),
        });
        const now = Date.now();
        if (structural || now - lastStreamedUpdate >= 250) {
          emitUpdate();
          return;
        }
        if (!pendingFlush) {
          pendingFlush = setTimeout(emitUpdate, 250 - (now - lastStreamedUpdate));
          pendingFlush.unref?.();
        }
      };

      const work = (async () => {
        try {
          const result = await runTasks(specs, {
            semaphore: runtime.semaphore,
            getPiCommand: runtime.getPiCommand,
            sessionDir: runtime.config.sessionDir,
            worktrees: runtime.worktrees,
            killGraceMs: runtime.config.killGraceMs,
            locks: runtime.locks,
            runId,
            parentSessionKey: runtime.key,
            signal: controller.signal,
            graceTurns: runtime.config.graceTurns,
            stallAfterMs: runtime.config.stallAfterMs,
            stallKillAfterMs: runtime.config.stallKillAfterMs,
            maxRetries: runtime.config.maxRetries,
            onRunnerCreated: (index, runner) => {
              let runners = runtime.liveRunners.get(runId);
              if (!runners) runtime.liveRunners.set(runId, (runners = new Map()));
              runners.set(index, runner);
            },
            onTaskProgress: (index, partial) => {
              if (runtime.closed || current !== runtime) return;
              // Keep the durable run record's childSessionId in sync the first
              // time we learn it (also used by orphan reclaim).
              if (partial.sessionId && partial.process) {
                runtime.locks.writeRunRecord({
                  runId: specs.length > 1 ? `${runId}:${index}` : runId,
                  parentSessionKey: runtime.key,
                  childSessionId: partial.sessionId,
                  process: {
                    pid: partial.process.pid,
                    startTime: partial.process.startTime,
                    pgid: partial.process.pgid,
                    hostname: partial.process.hostname ?? "unknown",
                  },
                  startedAt: Date.now(),
                  state: "running",
                  updatedAt: Date.now(),
                });
              }
              runtime.registry.checkpoint(runId, runtime.key, {
                resultIndex: index,
                resultUpdate: partial,
                childSessionId: partial.sessionId,
                progress: partial.liveText?.slice(0, 200),
                turn: partial.usage?.turns,
                state: partial.state,
              });
              streamUpdate(index, partial);
            },
          });
          // Optional fan-in: one read-only child folds parallel outputs into a
          // single brief, delivered first. Failures degrade to raw results.
          if (validated.synthesis && result.results.length > 1 && !controller.signal.aborted) {
            const synthesized = await runSynthesis(runtime, validated.synthesis, result.results, {
              runId,
              model: validated.tasks[0]?.model,
              signal: controller.signal,
            });
            if (synthesized) result.results = [synthesized, ...result.results];
          }
          runtime.registry.complete(runId, runtime.key, result.state, result.summary, result.results);
          return result;
        } catch (error: any) {
          const failed: TaskResult = {
            label: "task-1", task: specs[0]?.task ?? "", state: "failed", exitCode: 1,
            messages: [], stderr: "", usage: emptyUsage(), stopReason: "error", errorMessage: error?.message ?? String(error),
            protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, agentSettledSeen: false, validEvents: 0, parseErrors: 0 },
          };
          runtime.registry.complete(runId, runtime.key, "failed", failed.errorMessage, [failed]);
          return { mode: "single" as const, results: [failed], state: "failed" as const, summary: failed.errorMessage! };
        } finally {
          if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = undefined; }
          runtime.liveRunners.delete(runId);
          signal?.removeEventListener("abort", parentAbort);
          for (const session of directResumes) runtime.registry.releaseResumeLock(session, runtime.key, runId);
          resolveDone();
        }
      })();

      if (validated.async) {
        runtime.asyncRuns.add(runId);
        return { content: [{ type: "text", text: `Started run ${runId}. You will be notified on completion; use status/wait/cancel with this full id, or open /subagents.` }], details: details(validated.mode as "single" | "parallel", []) };
      }
      const result = await work;
      runtime.registry.markDelivered(runId, runtime.key);
      const delivered = runtime.output.capOutputForDelivery(result.results);
      const text = delivered.text || result.summary;
      const finished = runtime.registry.lookup(runId, runtime.key);
      const meta: RunMeta | undefined = finished.status === "found" && finished.run && !("controller" in finished.run)
        ? finished.run
        : { state: result.state };
      // timeout is reportable content (with timeoutPhase for retry policy), not a hard throw.
      if (result.state === "failed") fail(text);
      return { content: [{ type: "text", text }], details: details(result.mode, delivered.cappedResults as any, meta) };
    },
    renderCall(args, theme, context) {
      // Stable component identity: reuse the previous block and swap content.
      const block = (context.lastComponent instanceof LineBlock ? context.lastComponent : new LineBlock()) as LineBlock;
      block.set((width) => [renderCallLine(args, theme, width)]);
      return block;
    },
    renderResult(result, options: ToolRenderResultOptions, theme, context) {
      const block = (context.lastComponent instanceof LineBlock ? context.lastComponent : new LineBlock()) as LineBlock;
      const detailsValue = result.details as ReturnType<typeof compactDetails> | undefined;
      if (!detailsValue?.results.length) {
        const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
        block.set((width) => String(text).split("\n").map((line) => truncateToWidth(theme.fg("toolOutput", line), width)));
        return block;
      }
      const run: InlineRunView = {
        mode: detailsValue.mode,
        state: detailsValue.state,
        startedAt: detailsValue.startedAt,
        endedAt: detailsValue.endedAt,
        results: detailsValue.results.map((task: any) => ({
          label: task.label,
          state: task.state,
          usage: task.usage,
          model: task.model,
          stopReason: task.stopReason,
          timeoutPhase: task.timeoutPhase,
          errorMessage: task.errorMessage,
          finalOutput: task.finalOutput,
          outputFile: task.outputFile,
          sessionId: task.sessionId,
          worktree: task.worktree,
          wrappedUp: task.wrappedUp,
          stalledSince: task.stalledSince,
          attempts: task.attempts,
          structuredOutput: task.structuredOutput,
          structuredError: task.structuredError,
        })),
      };
      const active = options.isPartial && (isActiveState(detailsValue.state) || run.results.some((task) => isActiveState(task.state)) || detailsValue.state === undefined);
      block.set((width) => {
        const lines = renderRunLines(run, {
          theme,
          width,
          expanded: options.expanded,
          isPartial: active,
          spinnerFrame: liveSpinnerFrame(),
        });
        if (!options.expanded && !active && run.results.some((task) => task.finalOutput || task.errorMessage)) {
          // keyHint output is already themed; only add color to the raw fallback.
          const hint = expandHint();
          lines.push(truncateToWidth(hint.includes("\u001b[") ? hint : theme.fg("dim", hint), width));
        }
        return lines;
      });
      return block;
    },
  });
}
