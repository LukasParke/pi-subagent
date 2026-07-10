import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { defaultConfig, type SubagentConfig } from "./config.js";
import { formatStatusPreview, renderCall as renderCallLines, renderResult as renderResultLines } from "./format.js";
import { runTasks } from "./orchestrator.js";
import { OutputManager } from "./output.js";
import { parseDepth, validateSubagentRequest, type ResolvedTask } from "./policy.js";
import { SessionScopedRunRegistry, type LiveRun } from "./registry.js";
import { SubagentParamsSchema, type SubagentParams } from "./schema.js";
import { Semaphore } from "./semaphore.js";
import type { RunSnapshot, TaskResult, TaskSpec } from "./types.js";
import { emptyUsage } from "./types.js";
import { buildUsageLedger, formatLedger } from "./usage.js";
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
  footer?: FooterStatusModel;
  unsubscribe?: () => void;
  pendingRootMessages: import("@earendil-works/pi-ai").Message[];
  closed: boolean;
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId() || `ephemeral:${ctx.cwd}`;
}

function toSnapshot(run: LiveRun): RunSnapshot {
  return {
    schemaVersion: 1,
    id: run.id,
    sessionKey: run.sessionKey,
    mode: run.mode,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    taskPreviews: run.taskPreviews,
    summary: run.summary,
    delivered: run.delivered,
    results: run.results.map((result) => ({
      label: result.label,
      task: result.task,
      state: result.state,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      usage: result.usage,
      model: result.model,
      thinking: result.thinking,
      profile: result.profile,
      canWrite: result.canWrite,
      outputFile: result.outputFile,
      outputMode: result.outputMode,
      worktree: result.worktree,
      sessionId: result.sessionId,
      finalOutput: result.liveText,
      transcript: result.messages
        .flatMap((message: any) => message.role === "assistant" && Array.isArray(message.content)
          ? message.content.map((part: any) => part.type === "text" ? part.text : part.type === "toolCall" ? `→ ${part.name} ${JSON.stringify(part.arguments ?? {})}` : "")
          : message.role === "toolResult" ? [`← ${message.toolName}`] : [])
        .filter(Boolean)
        .join("\n") || undefined,
    })),
  };
}

function activeEntries(runtime: SessionRuntime): readonly unknown[] {
  return runtime.ctx.sessionManager.getBranch();
}

function ledger(runtime: SessionRuntime) {
  const entries = activeEntries(runtime);
  return buildUsageLedger(
    entries,
    [
      ...runtime.registry.getLiveRuns(runtime.key).map(toSnapshot),
      ...runtime.registry.getSnapshots(runtime.key),
    ],
    runtime.pendingRootMessages,
  );
}

function makeAdapter(runtime: SessionRuntime): SubagentAdapter {
  return {
    getActiveRuns: () => runtime.registry.getLiveRuns(runtime.key).map(toSnapshot),
    getCompletedRuns: () => runtime.registry.getSnapshots(runtime.key),
    getRunById(id) {
      const found = runtime.registry.lookup(id, runtime.key);
      if (found.status !== "found" || !found.run) return null;
      return "controller" in found.run ? toSnapshot(found.run) : found.run;
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
  const text = runtime.footer.render(runtime.ctx.ui.theme, 160);
  const totals = ledger(runtime).combined;
  const hasUsage = totals.cost > 0 || totals.turns > 0;
  runtime.ctx.ui.setStatus("subagent", active || runtime.registry.getSnapshots(runtime.key).some((run) => !run.delivered) || hasUsage ? text : undefined);
}

function utf8Preview(value: unknown, maxBytes: number): string {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function compactDetails(mode: "single" | "parallel", results: Array<TaskResult | RunSnapshot["results"][number]>) {
  const perResultText = Math.max(256, Math.floor(defaultConfig.maxDetailsTextBytes / Math.max(1, results.length) / 2));
  return {
    mode,
    results: results.map((result: any) => ({
      label: result.label,
      task: String(result.task ?? "").slice(0, 500),
      state: result.state,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
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
      finalOutput: utf8Preview(result.finalOutput ?? result.liveText, perResultText),
      transcript: utf8Preview(result.transcript, perResultText),
    })),
  };
}

function lineComponent(render: (width: number) => string[]): Component {
  return { render, invalidate() {} };
}

function expandHint(): string {
  // Keep the coding-agent package type-only so Node 20 does not load Pi's
  // provider/network stack merely to render a label.
  return "expand";
}

function fail(message: string): never {
  throw new Error(message);
}

function guidelines(): string[] {
  return [
    "Delegate independent, read-heavy exploration or clean-context review; keep tightly coupled work in the parent.",
    "Parallel tasks default to the strict read-only explore profile. Use isolated worktrees for parallel writers.",
    "Specify objective, context, scope, exclusions, output format, success criteria, and effort/budget.",
    "Use output_mode:file-only for large results; status is compact and wait delivers once.",
  ];
}

export default function registerSubagent(pi: ExtensionAPI): void {
  let current: SessionRuntime | undefined;

  async function teardown(runtime: SessionRuntime): Promise<void> {
    if (runtime.closed) return;
    await runtime.registry.shutdown(runtime.key, 8_000);
    runtime.closed = true;
    runtime.unsubscribe?.();
    runtime.footer?.dispose();
    runtime.ctx.ui.setStatus("subagent", undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (current && !current.closed) await teardown(current);
    const runtime = {} as SessionRuntime;
    runtime.key = sessionKey(ctx);
    runtime.ctx = ctx;
    runtime.config = { ...defaultConfig };
    runtime.output = new OutputManager(runtime.config);
    runtime.semaphore = new Semaphore(runtime.config.maxActiveProcesses, runtime.config.maxQueuedTasks);
    runtime.worktrees = new WorktreeManager();
    runtime.pendingRootMessages = [];
    runtime.closed = false;
    runtime.registry = new SessionScopedRunRegistry(runtime.config, {
      getEntries: () => ctx.sessionManager.getBranch() as any[],
      appendEntry: (type, data) => {
        // Captured runtime ownership prevents an old async callback from appending to a new session.
        if (current !== runtime || runtime.closed || sessionKey(ctx) !== runtime.key) return;
        pi.appendEntry(type, data);
      },
    });
    if (ctx.hasUI) {
      runtime.footer = new FooterStatusModel(makeAdapter(runtime));
      runtime.footer.setOnUpdate(() => refreshFooter(runtime));
      runtime.unsubscribe = runtime.registry.subscribe((event) => {
        if (event.sessionKey !== runtime.key) return;
        if (event.type === "terminal") {
          runtime.footer?.notifyTerminal(
            event.runId,
            `Subagent ${event.runId.slice(0, 8)} ${event.state}`,
            event.state === "completed" ? "info" : "warn",
          );
        }
        refreshFooter(runtime);
      });
    }
    current = runtime;
    refreshFooter(runtime);
  });

  pi.on("message_end", async (event) => {
    const runtime = current;
    if (!runtime || runtime.closed || event.message.role !== "assistant") return;
    // Supplement immediately; ledger deduplicates when SessionManager exposes it.
    runtime.pendingRootMessages.push(event.message);
    if (runtime.pendingRootMessages.length > 20) runtime.pendingRootMessages.shift();
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
    promptGuidelines: guidelines(),
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
      });
      if (!validated.ok) fail(validated.error);

      if (["status", "wait", "cancel"].includes(validated.mode)) {
        if (validated.mode === "status" && !validated.id) {
          const runs = [
            ...runtime.registry.getLiveRuns(runtime.key).map(toSnapshot),
            ...runtime.registry.getSnapshots(runtime.key),
          ];
          const text = [runs.length ? runs.map((run) => formatStatusPreview(run)).join("\n") : "No subagent runs.", formatLedger(ledger(runtime))].join("\n\n");
          return { content: [{ type: "text", text }], details: compactDetails("single", []) };
        }
        const found = runtime.registry.lookup(validated.id!, runtime.key);
        if (found.status === "ambiguous") fail(`Ambiguous id. Matches: ${found.matches!.join(", ")}`);
        if (found.status !== "found" || !found.run) fail(`Run ${validated.id} was not found in this session.`);
        const snapshot = "controller" in found.run ? toSnapshot(found.run) : found.run;
        if (validated.mode === "status") {
          return { content: [{ type: "text", text: `${formatStatusPreview(snapshot)}\n${formatLedger(ledger(runtime))}` }], details: compactDetails(snapshot.mode, snapshot.results) };
        }
        if (validated.mode === "cancel") {
          if ("controller" in found.run) found.run.controller.abort();
          return { content: [{ type: "text", text: `Cancellation requested for ${snapshot.id}` }], details: compactDetails(snapshot.mode, snapshot.results) };
        }
        if ("promise" in found.run) await found.run.promise.catch(() => {});
        const refreshed = runtime.registry.lookup(snapshot.id, runtime.key);
        const terminal = refreshed.status === "found" && refreshed.run
          ? "controller" in refreshed.run ? toSnapshot(refreshed.run) : refreshed.run
          : snapshot;
        if (!runtime.registry.markDelivered(terminal.id, runtime.key)) {
          return { content: [{ type: "text", text: `Run ${terminal.id} was already delivered. Artifacts and sessions remain available in /subagents.` }], details: compactDetails(terminal.mode, terminal.results) };
        }
        const delivered = runtime.output.capOutputForDelivery(terminal.results);
        const text = delivered.text || terminal.summary || "(no output)";
        if (terminal.state === "failed" || terminal.state === "lost") fail(text);
        return { content: [{ type: "text", text }], details: compactDetails(terminal.mode, delivered.cappedResults as any) };
      }

      const specs: TaskSpec[] = validated.tasks.map((task: ResolvedTask) => ({
        task: task.task,
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
        resume: task.resume,
        forkResume: task.forkResume,
        isolation: task.isolation,
        allowSharedWrites: task.allowSharedWrites,
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

      const work = (async () => {
        try {
          const result = await runTasks(specs, {
            semaphore: runtime.semaphore,
            sessionDir: runtime.config.sessionDir,
            worktrees: runtime.worktrees,
            signal: controller.signal,
            onTaskProgress: (index, partial) => {
              if (runtime.closed || current !== runtime) return;
              runtime.registry.checkpoint(runId, runtime.key, {
                resultIndex: index,
                resultUpdate: partial,
                childSessionId: partial.sessionId,
                progress: partial.liveText?.slice(0, 200),
                turn: partial.usage?.turns,
                state: partial.state,
              });
              const live = runtime.registry.lookup(runId, runtime.key);
              if (live.status === "found" && live.run) {
                const snap = "controller" in live.run ? toSnapshot(live.run) : live.run;
                onUpdate?.({ content: [{ type: "text", text: formatStatusPreview(snap) }], details: compactDetails(snap.mode, snap.results) });
              }
            },
          });
          runtime.registry.complete(runId, runtime.key, result.state, result.summary, result.results);
          return result;
        } catch (error: any) {
          const failed: TaskResult = {
            label: "task-1", task: specs[0]?.task ?? "", state: "failed", exitCode: 1,
            messages: [], stderr: "", usage: emptyUsage(), stopReason: "error", errorMessage: error?.message ?? String(error),
            protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, validEvents: 0, parseErrors: 0 },
          };
          runtime.registry.complete(runId, runtime.key, "failed", failed.errorMessage, [failed]);
          return { mode: "single" as const, results: [failed], state: "failed" as const, summary: failed.errorMessage! };
        } finally {
          signal?.removeEventListener("abort", parentAbort);
          for (const session of directResumes) runtime.registry.releaseResumeLock(session, runtime.key, runId);
          resolveDone();
        }
      })();

      if (validated.async) {
        return { content: [{ type: "text", text: `Started run ${runId}. Use status/wait/cancel with this full id, or open /subagents.` }], details: compactDetails(validated.mode as "single" | "parallel", []) };
      }
      const result = await work;
      runtime.registry.markDelivered(runId, runtime.key);
      const delivered = runtime.output.capOutputForDelivery(result.results);
      const text = delivered.text || result.summary;
      if (result.state === "failed") fail(text);
      return { content: [{ type: "text", text }], details: compactDetails(result.mode, delivered.cappedResults as any) };
    },
    renderCall(args, theme, context) {
      const hint = expandHint();
      return lineComponent((width) => renderCallLines(args, { expanded: context.expanded, theme, width, keyHint: hint }));
    },
    renderResult(result, options: ToolRenderResultOptions, theme, _context) {
      const details = result.details as ReturnType<typeof compactDetails> | undefined;
      if (!details?.results.length) {
        const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
        return new Text(text, 0, 0);
      }
      const container = new Container();
      for (const task of details.results) {
        container.addChild(lineComponent((width) => {
          const lines = renderResultLines(task as any, { expanded: options.expanded, theme, width });
          if (options.expanded && task.finalOutput) {
            lines.push(...String(task.finalOutput).split("\n").slice(0, 30).map((line) => theme.fg("toolOutput", line)));
          }
          return lines;
        }));
      }
      return container;
    },
  });
}
