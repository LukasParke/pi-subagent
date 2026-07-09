import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI, Component, OverlayHandle } from '@earendil-works/pi-tui';
import type { RunSnapshot, RunState, UsageStats } from './types.js';
import * as format from './format.js';
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { EventEmitter } from 'node:events';

/**
 * UI layer for standalone pi-subagent.
 * Independent via structural adapters.
 * Owns: footer status, /subagents overlay, renderers.
 * Prefers event-driven requestRender(). Only one animation timer.
 */

export interface SubagentAdapter {
  getActiveRuns(): RunSnapshot[];
  getCompletedRuns(): RunSnapshot[];
  getRunById(id: string): RunSnapshot | null;
  cancelRun(id: string): void;
  dismissRun(id: string): void;
  resumeRun(id: string): Promise<void>;
  showOutput(id: string): void;
  getReadyCount(): number;
  notify?(message: string, level?: 'info' | 'warn' | 'error'): void;
}

export interface UIAction {
  type: 'cancel' | 'dismiss' | 'resume' | 'output' | 'close' | 'select';
  id?: string;
  payload?: any;
}

export class FooterStatusModel {
  private adapter: SubagentAdapter;
  private lastNotification = 0;
  private runningCount = 0;
  private deliveredCount = 0;
  private _onUpdate?: () => void;

  constructor(adapter: SubagentAdapter) {
    this.adapter = adapter;
  }

  setOnUpdate(cb: () => void) {
    this._onUpdate = cb;
  }

  update(running: number, delivered: number) {
    const changed = this.runningCount !== running || this.deliveredCount !== delivered;
    this.runningCount = running;
    this.deliveredCount = delivered;
    if (changed && this._onUpdate) this._onUpdate();
  }

  /** Status for footer. Supports running and completed-undelivered. Does not immediately clear. */
  render(theme: Theme, width: number): string {
    const ready = this.adapter.getReadyCount();
    const active = this.runningCount;
    const pending = this.deliveredCount; // completed but not yet delivered to user
    let status = theme.fg('muted', 'subagents: ');
    if (active > 0) {
      status += theme.fg('warning', `${active} running `);
    }
    status += theme.fg('dim', `${ready} ready`);
    if (pending > 0) {
      status += theme.fg('accent', ` /${pending} pending`);
    }
    status += theme.fg('muted', ' • /subagents');
    return truncateToWidth(status, width);
  }

  /** Notification events modeled once per terminal transition. */
  notifyTransition(message: string, level: 'info' | 'warn' = 'info') {
    const now = Date.now();
    if (now - this.lastNotification > 250) { // debounce per transition
      this.adapter.notify?.(message, level);
      this.lastNotification = now;
      if (this._onUpdate) this._onUpdate();
    }
  }

  dispose() {
    this._onUpdate = undefined;
  }
}

interface SubagentsModel {
  listMode: boolean;
  selectedIndex: number;
  detailId?: string;
  scrollOffset: number;
  expanded: boolean; // for live parallel
}

export class SubagentsOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private done: (result?: any) => void;
  private adapter: SubagentAdapter;
  private model: SubagentsModel = {
    listMode: true,
    selectedIndex: 0,
    scrollOffset: 0,
    expanded: false,
  };
  private animationFrame = 0;
  private animationInterval?: NodeJS.Timeout;
  private emitter = new EventEmitter();
  private cachedLines?: string[];
  private cachedWidth = 0;
  private isDisposed = false;

  constructor(tui: TUI, theme: Theme, done: (result?: any) => void, adapter: SubagentAdapter) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.adapter = adapter;
    this.startAnimation();
  }

  private startAnimation() {
    if (this.animationInterval || this.isDisposed) return;
    this.animationInterval = setInterval(() => {
      if (this.hasRunningTasks() && !this.isDisposed) {
        this.animationFrame = (this.animationFrame + 1) % format.SPINNERS.length;
        this.invalidate();
        this.requestRender();
      } else if (this.animationInterval) {
        clearInterval(this.animationInterval);
        this.animationInterval = undefined;
      }
    }, 120); // ~8fps for spinner
  }

  private hasRunningTasks(): boolean {
    return this.adapter.getActiveRuns().some(r => r.state === 'running');
  }

  private requestRender() {
    // event-driven via TUI handle if available, but since overlay, we use invalidate which triggers re-render
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.isDisposed) return;

    const runs = this.getVisibleRuns();

    if (matchesKey(data, 'escape') || matchesKey(data, 'q')) {
      this.close();
      return;
    }

    if (this.model.listMode) {
      this.handleListInput(data, runs);
    } else {
      this.handleDetailInput(data);
    }
    this.invalidate();
    this.requestRender();
  }

  private handleListInput(data: string, runs: RunSnapshot[]) {
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.model.selectedIndex = Math.min(this.model.selectedIndex + 1, runs.length - 1);
    } else if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.model.selectedIndex = Math.max(this.model.selectedIndex - 1, 0);
    } else if (matchesKey(data, 'return') && runs.length > 0) {
      const selected = runs[this.model.selectedIndex];
      if (selected) {
        this.model.listMode = false;
        this.model.detailId = selected.id;
        this.model.scrollOffset = 0;
        this.model.expanded = true; // default expanded for details
      }
    } else if (matchesKey(data, 'c') && runs.length > 0) {
      const selected = runs[this.model.selectedIndex];
      if (selected?.state === 'running') {
        this.adapter.cancelRun(selected.id);
        this.emitter.emit('action', { type: 'cancel', id: selected.id } as UIAction);
      }
    } else if (matchesKey(data, 'd')) {
      const selected = runs[this.model.selectedIndex];
      if (selected) {
        this.adapter.dismissRun(selected.id);
        this.emitter.emit('action', { type: 'dismiss', id: selected.id } as UIAction);
        if (this.model.selectedIndex >= runs.length - 1) this.model.selectedIndex = Math.max(0, runs.length - 2);
      }
    } else if (matchesKey(data, 'r')) {
      const selected = runs[this.model.selectedIndex];
      if (selected) {
        this.adapter.resumeRun(selected.id).catch(console.error);
        this.emitter.emit('action', { type: 'resume', id: selected.id } as UIAction);
      }
    } else if (matchesKey(data, 'o')) {
      const selected = runs[this.model.selectedIndex];
      if (selected) {
        this.adapter.showOutput(selected.id);
        this.emitter.emit('action', { type: 'output', id: selected.id } as UIAction);
      }
    } else if (matchesKey(data, 'tab')) {
      this.model.expanded = !this.model.expanded;
    }
  }

  private handleDetailInput(data: string) {
    if (matchesKey(data, 'escape') || matchesKey(data, 'b') || matchesKey(data, 'backspace')) {
      this.model.listMode = true;
      this.model.detailId = undefined;
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.model.scrollOffset += 1;
    } else if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.model.scrollOffset = Math.max(0, this.model.scrollOffset - 1);
    } else if (matchesKey(data, 'c')) {
      const detail = this.getCurrentDetail();
      if (detail && detail.state === 'running') {
        this.adapter.cancelRun(detail.id);
        this.emitter.emit('action', { type: 'cancel', id: detail.id });
      }
    } else if (matchesKey(data, 'o')) {
      const detail = this.getCurrentDetail();
      if (detail) {
        this.adapter.showOutput(detail.id);
        this.emitter.emit('action', { type: 'output', id: detail.id });
      }
    } else if (matchesKey(data, 'tab')) {
      this.model.expanded = !this.model.expanded;
    }
  }

  private getVisibleRuns(): RunSnapshot[] {
    return [...this.adapter.getActiveRuns(), ...this.adapter.getCompletedRuns()];
  }

  private getCurrentDetail(): RunSnapshot | null {
    if (!this.model.detailId) return null;
    return this.adapter.getRunById(this.model.detailId);
  }

  render(width: number): string[] {
    if (this.isDisposed) return ['[disposed]'];

    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const header = this.theme.bold(this.theme.fg('toolTitle', ' /subagents '));
    lines.push(truncateToWidth(header + this.theme.fg('muted', '(Esc to close)'), width));

    if (this.model.listMode) {
      this.renderListScreen(lines, width);
    } else {
      this.renderDetailScreen(lines, width);
    }

    // Footer hint
    const hints = ['↑↓ navigate', 'Enter detail', 'c cancel', 'd dismiss', 'r resume', 'o output', 'Tab expand', 'Esc close'];
    lines.push('');
    lines.push(truncateToWidth(this.theme.fg('dim', hints.join(' • ')), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderListScreen(lines: string[], width: number) {
    const runs = this.getVisibleRuns();
    if (runs.length === 0) {
      lines.push(this.theme.fg('muted', '  No subagents. Use subagent tool or /subagents to manage.'));
      return;
    }

    runs.forEach((run, idx) => {
      const isSelected = idx === this.model.selectedIndex;
      const prefix = isSelected ? this.theme.fg('accent', '▶ ') : '  ';
      const spinnerFrame = this.animationFrame;
      const opts: format.RenderOptions = {
        expanded: this.model.expanded,
        theme: this.theme,
        width: width - 4,
        spinnerFrame,
      };
      const rendered = format.renderResult(run, opts);
      const firstLine = rendered[0] || format.formatStatusPreview(run);
      const line = prefix + firstLine;
      lines.push(truncateToWidth(line, width));
      if (isSelected && this.model.expanded && rendered.length > 1) {
        rendered.slice(1, 4).forEach(l => lines.push('    ' + truncateToWidth(l, width - 4)));
      }
    });
  }

  private renderDetailScreen(lines: string[], width: number) {
    const detail = this.getCurrentDetail();
    if (!detail) {
      lines.push(this.theme.fg('error', 'No detail available'));
      lines.push(this.theme.fg('muted', 'Esc to return to list'));
      return;
    }

    const opts: format.RenderOptions = {
      expanded: true,
      theme: this.theme,
      width: width - 2,
      spinnerFrame: this.animationFrame,
      liveText: (detail as any).liveText,
    };
    const rendered = format.renderResult(detail, opts);
    rendered.forEach(l => lines.push(l));

    lines.push('');
    lines.push(this.theme.bold(this.theme.fg('muted', '── Full Transcript / Activity ──')));

    // Scrollable full transcript/activity (simulated from messages or summary)
    const transcript = this.getTranscript(detail);
    const transcriptWrapped = wrapTextWithAnsi(transcript, width - 4);
    const wrapped = String(transcriptWrapped).split('\n');
    const visibleStart = Math.max(0, this.model.scrollOffset);
    const visibleLines = wrapped.slice(visibleStart, visibleStart + 12);
    visibleLines.forEach((l: string) => lines.push('  ' + truncateToWidth(l, width - 4)));

    if (wrapped.length > visibleStart + 12) {
      lines.push(this.theme.fg('muted', `  ... (${wrapped.length - visibleStart - 12} more lines, ↓/↑ scroll)`));
    }
  }

  private getTranscript(run: RunSnapshot): string {
    if (run.summary) return run.summary;
    if (run.taskPreviews && run.taskPreviews.length > 0) {
      return run.taskPreviews.join('\n\n');
    }
    return 'No transcript available. Full details in persistence layer. Expanded mode works for parallel live updates via liveText and timers.';
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = 0;
  }

  onAction(listener: (action: UIAction) => void) {
    this.emitter.on('action', listener);
    return () => this.emitter.off('action', listener);
  }

  close() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = undefined;
    }
    this.emitter.emit('action', { type: 'close' } as UIAction);
    this.done();
    this.dispose();
  }

  private dispose() {
    this.emitter.removeAllListeners();
    this.isDisposed = true;
  }

  wantsKeyRelease = false;
}

/** Helper to create the overlay (used by extension wiring). Returns handle proxy. */
export function createSubagentsOverlay(
  tui: TUI,
  theme: Theme,
  adapter: SubagentAdapter,
  done: (result?: any) => void
): SubagentsOverlay {
  return new SubagentsOverlay(tui, theme, done, adapter);
}

/** Test-friendly pure model for UI state */
export class SubagentsUIModel {
  private adapter: SubagentAdapter;
  public state: SubagentsModel = { listMode: true, selectedIndex: 0, scrollOffset: 0, expanded: false };

  constructor(adapter: SubagentAdapter) {
    this.adapter = adapter;
  }

  get runs() { return this.adapter.getActiveRuns().concat(this.adapter.getCompletedRuns()); }

  select(index: number) {
    this.state.selectedIndex = Math.max(0, Math.min(index, this.runs.length - 1));
  }

  toggleExpanded() {
    this.state.expanded = !this.state.expanded;
  }

  drillDown() {
    if (this.runs.length > 0) {
      this.state.listMode = false;
      this.state.detailId = this.runs[this.state.selectedIndex]?.id;
    }
  }

  goBack() {
    this.state.listMode = true;
    this.state.detailId = undefined;
  }

  simulateKey(key: string): UIAction | null {
    // Simulation for tests - returns action if triggered
    if (key === 'Escape') return { type: 'close' };
    if (key === 'Enter' && this.state.listMode) {
      this.drillDown();
      return { type: 'select', id: this.state.detailId };
    }
    if (key === 'c' && this.state.listMode) {
      const run = this.runs[this.state.selectedIndex];
      if (run) return { type: 'cancel', id: run.id };
    }
    return null;
  }

  isRunning(): boolean {
    return this.runs.some(r => r.state === 'running');
  }
}
