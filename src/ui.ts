import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RunSnapshot } from "./types.js";
import { formatStatusPreview, SPINNERS } from "./format.js";

export interface SubagentAdapter {
  getActiveRuns(): RunSnapshot[];
  getCompletedRuns(): RunSnapshot[];
  getRunById(id: string): RunSnapshot | null;
  cancelRun(id: string): void;
  dismissRun(id: string): void;
  resumeRun(id: string): Promise<void>;
  showOutput(id: string): void;
  getReadyCount(): number;
  getUsageSummary?(): string;
  subscribe?(listener: () => void): () => void;
  notify?(message: string, level?: "info" | "warn" | "error"): void;
}

export interface UIAction {
  type: "cancel" | "dismiss" | "resume" | "output" | "close" | "select";
  id?: string;
}

export class FooterStatusModel {
  constructor(private readonly adapter: SubagentAdapter) {}
  private running = 0;
  private onUpdate?: () => void;
  private notified = new Set<string>();

  setOnUpdate(callback: () => void): void { this.onUpdate = callback; }
  update(running: number, _readyHint?: number): void {
    if (running !== this.running) {
      this.running = running;
      this.onUpdate?.();
    }
  }
  render(theme: Theme, width: number): string {
    const ready = this.adapter.getReadyCount();
    const parts = [
      this.running ? theme.fg("warning", `${this.running} running`) : "",
      ready ? theme.fg("success", `${ready} ready`) : "",
      this.adapter.getUsageSummary?.() ?? "",
      "/subagents",
    ].filter(Boolean);
    return truncateToWidth(parts.join(" · "), width);
  }
  notifyTerminal(id: string, message: string, level: "info" | "warn" = "info"): void {
    if (this.notified.has(id)) return;
    this.notified.add(id);
    this.adapter.notify?.(message, level);
    this.onUpdate?.();
  }
  notifyTransition(message: string, level: "info" | "warn" = "info"): void {
    this.notifyTerminal(message, message, level);
  }
  dispose(): void { this.onUpdate = undefined; this.notified.clear(); }
}

function runTranscript(run: RunSnapshot): string {
  const sections: string[] = [];
  if (run.summary) sections.push(`Summary\n${run.summary}`);
  run.results.forEach((result, index) => {
    const header = `${index + 1}. ${result.label} [${result.state}]`;
    const usage = `$${result.usage.cost.toFixed(4)} · in ${result.usage.input} · out ${result.usage.output}`;
    const capability = `${result.profile ?? "general"}/${result.canWrite ? "RW" : "RO"}${result.thinking ? ` · thinking:${result.thinking}` : ""}${result.model ? ` · ${result.model}` : ""}`;
    const pointers = [
      result.outputFile ? `Output: ${result.outputFile}` : "",
      result.sessionId ? `Session: ${result.sessionId}` : "",
      result.worktree ? `Worktree: ${result.worktree.cwd}\nBranch: ${result.worktree.branch}` : "",
    ].filter(Boolean).join("\n");
    sections.push([header, capability, usage, result.transcript || result.finalOutput || result.errorMessage || "(no output)", pointers].filter(Boolean).join("\n"));
  });
  return sections.join("\n\n") || run.taskPreviews.join("\n") || "(no transcript available)";
}

export class SubagentsOverlay implements Component {
  wantsKeyRelease = false;
  private selected = 0;
  private detailId?: string;
  private scroll = 0;
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly adapter: SubagentAdapter,
  ) {
    this.unsubscribe = this.adapter.subscribe?.(() => {
      if (this.disposed) return;
      this.syncAnimation();
      this.invalidate();
      this.tui.requestRender();
    });
    this.syncAnimation();
  }

  private runs(): RunSnapshot[] {
    return [...this.adapter.getActiveRuns(), ...this.adapter.getCompletedRuns()];
  }

  private syncAnimation(): void {
    const running = this.adapter.getActiveRuns().length > 0;
    if (running && !this.timer && !this.disposed) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNERS.length;
        this.invalidate();
        this.tui.requestRender();
        if (this.adapter.getActiveRuns().length === 0) this.stopAnimation();
      }, 120);
      this.timer.unref?.();
    } else if (!running) {
      this.stopAnimation();
    }
  }

  private stopAnimation(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  handleInput(data: string): void {
    const runs = this.runs();
    if (this.detailId) {
      if (matchesKey(data, "escape") || matchesKey(data, "backspace") || data === "b") {
        this.detailId = undefined;
        this.scroll = 0;
      } else if (matchesKey(data, "down") || data === "j") this.scroll++;
      else if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
      else this.handleAction(data, this.adapter.getRunById(this.detailId));
    } else if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
    } else if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "enter") && runs[this.selected]) {
      this.detailId = runs[this.selected]!.id;
      this.scroll = 0;
    } else {
      this.handleAction(data, runs[this.selected] ?? null);
    }
    this.syncAnimation();
    this.invalidate();
    this.tui.requestRender();
  }

  private handleAction(data: string, run: RunSnapshot | null): void {
    if (!run) return;
    if (data === "c" && ["queued", "running"].includes(run.state)) this.adapter.cancelRun(run.id);
    if (data === "d") this.adapter.dismissRun(run.id);
    if (data === "r") void this.adapter.resumeRun(run.id);
    if (data === "o") this.adapter.showOutput(run.id);
  }

  render(width: number): string[] {
    this.syncAnimation();
    const lines = [truncateToWidth(this.theme.bold(this.theme.fg("toolTitle", "Subagents")), width)];
    const usage = this.adapter.getUsageSummary?.();
    if (usage) lines.push(truncateToWidth(this.theme.fg("muted", usage), width));
    lines.push("");

    if (this.detailId) {
      const run = this.adapter.getRunById(this.detailId);
      if (!run) lines.push(this.theme.fg("error", "Run no longer exists"));
      else {
        lines.push(truncateToWidth(formatStatusPreview(run), width));
        lines.push("");
        const wrappedValue = wrapTextWithAnsi(runTranscript(run), Math.max(1, width - 2));
        const wrapped = Array.isArray(wrappedValue) ? wrappedValue : String(wrappedValue).split("\n");
        for (const line of wrapped.slice(this.scroll, this.scroll + 20)) lines.push(`  ${truncateToWidth(line, width - 2)}`);
        if (wrapped.length > this.scroll + 20) lines.push(this.theme.fg("muted", `  … ${wrapped.length - this.scroll - 20} more`));
        lines.push("");
        lines.push(this.theme.fg("dim", "↑↓ scroll · b/Esc back · c cancel · r resume · o output · d dismiss"));
      }
    } else {
      const runs = this.runs();
      if (!runs.length) lines.push(this.theme.fg("muted", "No subagent runs in this branch."));
      runs.forEach((run, index) => {
        const prefix = index === this.selected ? this.theme.fg("accent", "▶ ") : "  ";
        const spinner = ["queued", "running"].includes(run.state) ? `${SPINNERS[this.frame]} ` : "";
        lines.push(truncateToWidth(prefix + spinner + formatStatusPreview(run), width));
      });
      lines.push("");
      lines.push(this.theme.fg("dim", "↑↓ select · Enter details · c cancel · r resume · o output · d dismiss · Esc close"));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    // Stateless rendering; method required by Component.
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnimation();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

export function createSubagentsOverlay(tui: TUI, theme: Theme, adapter: SubagentAdapter, done: () => void): SubagentsOverlay {
  return new SubagentsOverlay(tui, theme, done, adapter);
}

/** Small pure model retained for regression tests. */
export class SubagentsUIModel {
  state = { listMode: true, selectedIndex: 0, scrollOffset: 0, expanded: false, detailId: undefined as string | undefined };
  constructor(private readonly adapter: SubagentAdapter) {}
  get runs(): RunSnapshot[] { return [...this.adapter.getActiveRuns(), ...this.adapter.getCompletedRuns()]; }
  select(index: number): void { this.state.selectedIndex = Math.max(0, Math.min(index, Math.max(0, this.runs.length - 1))); }
  toggleExpanded(): void { this.state.expanded = !this.state.expanded; }
  drillDown(): void { const run = this.runs[this.state.selectedIndex]; if (run) { this.state.listMode = false; this.state.detailId = run.id; } }
  goBack(): void { this.state.listMode = true; this.state.detailId = undefined; }
  simulateKey(key: string): UIAction | null {
    if (key === "Escape") return { type: "close" };
    if (key === "Enter") { this.drillDown(); return { type: "select", id: this.state.detailId }; }
    if (key === "c") return { type: "cancel", id: this.runs[this.state.selectedIndex]?.id };
    return null;
  }
  isRunning(): boolean { return this.runs.some((run) => ["queued", "running"].includes(run.state)); }
}
