import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { defaultConfig, type SubagentConfig } from "./config.js";
import { SubagentParamsSchema, type SubagentParams } from "./schema.js";
import { validateSubagentRequest, parseDepth, type ResolvedTask } from "./policy.js";
import { SessionScopedRunRegistry, type LiveRun } from "./registry.js";
import { OutputManager } from "./output.js";
import { runTasks } from "./orchestrator.js";
import { Semaphore } from "./semaphore.js";
import { WorktreeManager } from "./worktree.js";
import {
  createSubagentsOverlay,
  FooterStatusModel,
  type SubagentAdapter,
} from "./ui.js";
import { renderCall, renderResult, formatStatusPreview } from "./format.js";
import type { RunSnapshot, TaskResult, TaskSpec } from "./types.js";

const RUN_ENTRY = "subagent-run-v1";

function sessionKeyFrom(ctx: ExtensionContext): string {
  return (
    ctx.sessionManager.getSessionFile() ||
    ctx.sessionManager.getSessionId?.() ||
    "ephemeral"
  );
}

function liveToSnapshot(run: LiveRun): RunSnapshot {
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
    results: run.results.map((r) => ({
      label: r.label,
      task: r.task,
      state: r.state,
      exitCode: r.exitCode,
      stopReason: r.stopReason,
      errorMessage: r.errorMessage,
      usage: r.usage,
      model: r.model,
      outputFile: r.outputFile,
      sessionId: r.sessionId,
      finalOutput: r.liveText,
    })),
  };
}

function buildAdapter(
  registry: SessionScopedRunRegistry,
  key: string,
  ctx: ExtensionContext,
): SubagentAdapter {
  return {
    getActiveRuns() {
      return registry.getLiveRuns(key).map(liveToSnapshot);
    },
    getCompletedRuns() {
      const rt = registry.getSessionRuntime(key);
      return rt ? Array.from(rt.snapshots.values()) : [];
    },
    getRunById(id: string) {
      const found = registry.lookup(id, key);
      if (found.status !== "found" || !found.run) return null;
      const run = found.run as LiveRun | RunSnapshot;
      if ("controller" in run) return liveToSnapshot(run as LiveRun);
      return run as RunSnapshot;
    },
    cancelRun(id: string) {
      const found = registry.lookup(id, key);
      if (found.status === "found" && found.run && "controller" in found.run) {
        (found.run as LiveRun).controller.abort();
      }
    },
    dismissRun(id: string) {
      registry.markDismissed(id, key);
    },
    async resumeRun() {
      ctx.ui.notify("Use the subagent tool with resume=<sessionId> for follow-up", "info");
    },
    showOutput(id: string) {
      const snap = this.getRunById(id);
      const out = snap?.results.map((r) => r.outputFile || r.sessionId).filter(Boolean).join(", ");
      ctx.ui.notify(out || "No output path / session id", "info");
    },
    getReadyCount() {
      const rt = registry.getSessionRuntime(key);
      if (!rt) return 0;
      return Array.from(rt.snapshots.values()).filter((s) => !s.delivered && s.state !== "running")
        .length;
    },
    notify(message, level = "info") {
      ctx.ui.notify(message, level === "error" ? "error" : level === "warn" ? "warning" : "info");
    },
  };
}

function guidelines(): string {
  return [
    "Use the subagent tool to isolate exploratory research, parallel independent analysis, or clean-context review.",
    "Prefer profile 'explore' (default for parallel) or 'review' for read-only work. Never treat bash as read-only.",
    "Do not parallelize multiple writers on the same checkout unless each uses isolation:'worktree' or distinct cwd.",
    "Each task must be fully self-contained: objective, scope, sources, required output format, success criteria, and effort/budget.",
    "For large results use output + output_mode:'file-only' and return a pointer.",
    "Keep tightly-coupled implementation work in the parent; use a reviewer subagent after changes when useful.",
    "Manage background runs with action status/wait/cancel and the /subagents inspector.",
  ].join(" ");
}

export default function registerSubagent(pi: ExtensionAPI): void {
  let config: SubagentConfig = { ...defaultConfig };
  let registry: SessionScopedRunRegistry | null = null;
  let outputManager: OutputManager | null = null;
  let semaphore: Semaphore | null = null;
  let worktrees: WorktreeManager | null = null;
  let footer: FooterStatusModel | null = null;
  let currentKey = "ephemeral";
  let uiCtx: ExtensionContext | null = null;
  let statusTimer: NodeJS.Timeout | null = null;

  const stopStatusTimer = () => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  };

  const setFooterText = (text: string) => {
    // Best-effort: some Pi builds expose setStatus / setFooter via ui.
    const ui = uiCtx?.ui as any;
    if (ui?.setStatus) ui.setStatus("subagent", text);
    else if (ui?.setFooter) ui.setFooter(text);
  };

  const refreshStatus = () => {
    if (!registry || !footer || !uiCtx) {
      setFooterText("");
      return;
    }
    const live = registry.getLiveRuns(currentKey);
    const ready = footer["adapter"]
      ? (footer as any).adapter.getReadyCount()
      : 0;
    footer.update(live.length, ready);
    const themeStub = {
      fg: (_name: string, s: string) => s,
    } as Theme;
    setFooterText(footer.render(themeStub, 80));
    if (live.length === 0) stopStatusTimer();
  };

  const ensureTimer = () => {
    if (statusTimer || !uiCtx) return;
    statusTimer = setInterval(refreshStatus, 500);
    statusTimer.unref?.();
  };

  const persistenceAdapter = {
    appendEntry(type: string, payload: unknown) {
      try {
        pi.appendEntry(type, payload as any);
      } catch {
        // Session may be unavailable during teardown
      }
    },
    getEntries() {
      return (uiCtx?.sessionManager.getBranch?.() ||
        uiCtx?.sessionManager.getEntries?.() ||
        []) as any[];
    },
    getActiveBranch() {
      // getBranch returns entry chain; treat presence as "active"
      return "active";
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    currentKey = sessionKeyFrom(ctx);
    config = { ...defaultConfig };
    semaphore = new Semaphore(config.maxActiveProcesses, config.maxQueuedTasks);
    worktrees = new WorktreeManager();
    outputManager = new OutputManager(config);
    registry = new SessionScopedRunRegistry(config, persistenceAdapter);

    if (ctx.hasUI) {
      const adapter = buildAdapter(registry, currentKey, ctx);
      footer = new FooterStatusModel(adapter);
      footer.setOnUpdate(() => refreshStatus());
      refreshStatus();
    }
  });

  pi.on("session_shutdown", async () => {
    stopStatusTimer();
    if (registry) {
      await registry.shutdown(currentKey, 8_000);
      registry = null;
    }
    footer?.dispose();
    footer = null;
    uiCtx = null;
    setFooterText("");
  });

  pi.registerCommand("subagents", {
    description: "Inspect subagent runs (live + completed)",
    handler: async (_args, ctx) => {
      if (!registry) {
        ctx.ui.notify("Subagent registry not ready", "error");
        return;
      }
      const key = sessionKeyFrom(ctx);
      const adapter = buildAdapter(registry, key, ctx);
      await ctx.ui.custom(
        (tui: TUI, theme: Theme, _kb: unknown, done: (result?: unknown) => void) =>
          createSubagentsOverlay(tui, theme, adapter, done) as Component,
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } } as any,
      );
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate an isolated Pi subagent task (single, parallel, or cancellable background). " +
      guidelines(),
    promptGuidelines: guidelines().split(/(?<=\.)\s+/),
    parameters: SubagentParamsSchema as any,
    async execute(
      _toolCallId,
      rawParams: SubagentParams,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      if (!registry || !outputManager || !semaphore || !worktrees) {
        return {
          content: [{ type: "text", text: "Subagent extension is not initialized for this session." }],
          details: { mode: "single", results: [] },
          isError: true,
        };
      }

      // Runtime validation layer on top of TypeBox schema
      if (!Value.Check(SubagentParamsSchema, rawParams as any)) {
        const errors = [...Value.Errors(SubagentParamsSchema, rawParams as any)]
          .slice(0, 5)
          .map((e) => {
            const anyErr = e as { path?: string; instancePath?: string; message?: string };
            return `${anyErr.path ?? anyErr.instancePath ?? "?"}: ${anyErr.message ?? "invalid"}`;
          })
          .join("; ");
        return {
          content: [{ type: "text", text: `Invalid subagent parameters: ${errors}` }],
          details: { mode: "single", results: [] },
          isError: true,
        };
      }

      const model = (ctx as { model?: { id?: string; provider?: string } }).model;
      const modelId =
        model?.provider && model?.id
          ? `${model.provider}/${model.id}`
          : model?.id;

      const availableTools =
        pi.getAllTools?.().map((t: { name: string }) => t.name) ||
        pi.getActiveTools?.() ||
        ["read", "bash", "edit", "write", "grep", "find", "ls"];

      const validation = validateSubagentRequest(rawParams, {
        cwd: ctx.cwd,
        model: modelId,
        thinking: pi.getThinkingLevel?.() as TaskSpec["thinking"],
        availableTools,
        activeTools: pi.getActiveTools?.(),
        depth: parseDepth(),
      });

      if (!validation.ok) {
        return {
          content: [{ type: "text", text: validation.error }],
          details: { mode: "single", results: [] },
          isError: true,
        };
      }

      const key = sessionKeyFrom(ctx);

      // Management actions
      if (validation.mode === "status" || validation.mode === "wait" || validation.mode === "cancel") {
        const lookup = registry.lookup(validation.id ?? "", key);
        if (lookup.status === "ambiguous") {
          return {
            content: [
              {
                type: "text",
                text: `Ambiguous run id prefix. Matches: ${(lookup.matches || []).join(", ")}`,
              },
            ],
            details: { mode: "single", results: [] },
            isError: true,
          };
        }
        if (lookup.status === "not-found" || !lookup.run) {
          const live = registry.getLiveRuns(key);
          const ids = live.map((r) => r.id).join(", ") || "(none running)";
          return {
            content: [
              {
                type: "text",
                text: validation.id
                  ? `No run found for id "${validation.id}". Live: ${ids}`
                  : `No id provided. Live runs: ${ids}`,
              },
            ],
            details: { mode: "single", results: [] },
            isError: true,
          };
        }

        const run = lookup.run as LiveRun | RunSnapshot;
        const snap: RunSnapshot =
          "controller" in run ? liveToSnapshot(run as LiveRun) : (run as RunSnapshot);

        if (validation.mode === "status") {
          const preview = formatStatusPreview(snap);
          return {
            content: [{ type: "text", text: preview }],
            details: { mode: snap.mode, results: [] },
          };
        }

        if (validation.mode === "cancel") {
          if ("controller" in run) (run as LiveRun).controller.abort();
          return {
            content: [{ type: "text", text: `Cancelled run ${snap.id}` }],
            details: { mode: snap.mode, results: [] },
          };
        }

        // wait
        if ("promise" in run && "controller" in run) {
          await (run as LiveRun).promise.catch(() => {});
        }
        // refresh after completion
        const after = registry.lookup(snap.id, key);
        const finalSnap =
          after.status === "found" && after.run
            ? "controller" in after.run
              ? liveToSnapshot(after.run as LiveRun)
              : (after.run as RunSnapshot)
            : snap;

        registry.markDelivered(finalSnap.id, key);
        const capped = outputManager.capOutputForDelivery(finalSnap.results as any);
        return {
          content: [{ type: "text", text: capped.text || finalSnap.summary || "(no output)" }],
          details: {
            mode: finalSnap.mode,
            results: finalSnap.results as any,
          },
          isError: finalSnap.state === "failed" || finalSnap.state === "lost",
        };
      }

      // Launch tasks
      const specs: TaskSpec[] = validation.tasks.map((t: ResolvedTask) => ({
        task: t.task,
        systemPrompt: t.systemPrompt,
        model: t.model,
        thinking: t.thinking,
        tools: t.effectiveTools,
        profile: t.profile,
        cwd: t.cwd,
        timeoutMs: t.timeoutMs,
        maxTurns: t.maxTurns,
        maxCost: t.maxCost,
        output: t.output,
        outputMode: t.outputMode,
        resume: t.resume,
        forkResume: t.forkResume,
        isolation: t.isolation,
        allowSharedWrites: t.allowSharedWrites,
      }));

      // Resume locks
      for (const t of validation.tasks) {
        if (t.resume && !t.forkResume) {
          const ok = registry.acquireResumeLock(t.resume, "pending", key, false);
          // lock is re-acquired with real id after start
          if (!ok) {
            // still may be free; we'll lock with real id
          }
        }
      }

      const controller = new AbortController();
      const combined = signal
        ? AbortSignal.any
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal
        : controller.signal;

      if (signal) {
        const onParentAbort = () => controller.abort();
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onParentAbort, { once: true });
      }

      let resolvePromise!: (v: unknown) => void;
      const donePromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const labels = validation.tasks.map((t) => t.label);
      const runId = registry.start(
        key,
        validation.mode === "parallel" ? "parallel" : "single",
        specs,
        controller,
        donePromise,
        labels,
      );

      for (const t of validation.tasks) {
        if (t.resume && !t.forkResume) {
          registry.acquireResumeLock(t.resume, runId, key, false);
        }
      }

      const work = (async () => {
        try {
          const out = await runTasks(specs, {
            semaphore: semaphore!,
            sessionDir: config.sessionDir,
            worktrees: worktrees!,
            signal: combined as AbortSignal,
            onTaskProgress: (index, partial) => {
              registry?.checkpoint(runId, key, {
                resultIndex: index,
                resultUpdate: partial as Partial<TaskResult>,
                childSessionId: partial.sessionId,
                progress: partial.liveText?.slice(0, 120),
                turn: partial.usage?.turns,
              });
              ensureTimer();
              refreshStatus();
            },
          });

          for (const t of validation.tasks) {
            if (t.resume) registry?.releaseResumeLock(t.resume, key);
          }

          registry?.complete(runId, key, out.state, out.summary, out.results);
          footer?.notifyTransition(
            `Subagent ${runId.slice(0, 8)} ${out.state}`,
            out.state === "completed" ? "info" : "warn",
          );
          refreshStatus();
          return out;
        } catch (err: any) {
          const failed: TaskResult = {
            label: "subagent",
            task: specs[0]?.task ?? "",
            state: "failed",
            exitCode: 1,
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            stopReason: "error",
            errorMessage: err?.message ?? String(err),
            protocol: {
              headerSeen: false,
              assistantEndSeen: false,
              agentEndSeen: false,
              validEvents: 0,
              parseErrors: 0,
            },
          };
          registry?.complete(runId, key, "failed", failed.errorMessage, [failed]);
          refreshStatus();
          return {
            mode: "single" as const,
            results: [failed],
            state: "failed" as const,
            summary: failed.errorMessage ?? "error",
          };
        } finally {
          resolvePromise(true);
        }
      })();

      if (validation.async) {
        ensureTimer();
        refreshStatus();
        return {
          content: [
            {
              type: "text",
              text:
                `Started async subagent run ${runId}. ` +
                `Use { action: "status"|"wait"|"cancel", id: "${runId}" } or /subagents.`,
            },
          ],
          details: { mode: validation.mode === "parallel" ? "parallel" : "single", results: [] },
        };
      }

      const out = await work;
      registry.markDelivered(runId, key);
      const capped = outputManager.capOutputForDelivery(out.results);
      const isError = out.state === "failed";
      return {
        content: [{ type: "text", text: capped.text || out.summary }],
        details: { mode: out.mode, results: out.results },
        isError,
      };
    },

    renderCall(args: any, theme: Theme, context?: { expanded?: boolean; width?: number }) {
      const expanded = context?.expanded ?? false;
      const width = context?.width ?? 80;
      const lines = renderCall(args, {
        expanded,
        theme,
        width,
        keyHint: keyHint("app.tools.expand", "expand"),
      });
      // format.renderCall returns string[]; Pi components often expect Component.
      // Returning a plain string join is accepted by several tool render paths;
      // if Component is required, TUI will coerce via String().
      return lines as any;
    },

    renderResult(
      result: any,
      options: { expanded?: boolean; theme?: Theme; width?: number },
    ) {
      const theme = options.theme as Theme;
      const width = options.width ?? 80;
      const details = result?.details;
      if (details?.results?.length) {
        const lines: string[] = [];
        for (const r of details.results) {
          lines.push(
            ...renderResult(r, {
              expanded: options.expanded ?? false,
              theme,
              width,
            }),
          );
        }
        return lines as any;
      }
      const text = result?.content?.[0]?.text ?? "";
      return [text] as any;
    },
  });

  // Silence unused in some builds
  void RUN_ENTRY;
}
