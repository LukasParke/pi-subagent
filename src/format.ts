import type { UsageStats, TaskResult, RunSnapshot, RunState, TaskProfile } from './types.js';
import type { Theme } from '@earendil-works/pi-coding-agent';
import * as os from 'node:os';
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

/**
 * Formatting helpers for pi-subagent UI.
 * ANSI-safe, respects terminal width, supports spinners, elapsed, etc.
 * Independent of runner/registry.
 */

export const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function formatElapsed(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '0s';
  const elapsed = Math.max(0, now - ms);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs}s`;
}

export function formatTokens(n: number | undefined): string {
  if (!n || n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export function formatUsage(usage: UsageStats, model?: string, compact = true): string {
  const parts: string[] = [];
  if (usage.turns && usage.turns > 0) parts.push(`${usage.turns}t`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost > 0.0001) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model && !compact) parts.push(model);
  return parts.join(' ');
}

export function formatPath(p?: string): string {
  if (!p) return '(none)';
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p.length > 40 ? '...' + p.slice(-37) : p;
}

export function formatState(state: RunState, exitCode?: number | null): string {
  switch (state) {
    case 'running': return 'running';
    case 'completed': return exitCode === 0 ? 'done' : 'failed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'queued': return 'queued';
    case 'partial': return 'partial';
    case 'lost': return 'lost';
    default: return state;
  }
}

export function formatProfile(profile: TaskProfile, rw: 'RO' | 'RW' = 'RO'): string {
  const p = profile === 'explore' ? '🔍' : profile === 'review' ? '📋' : '⚡';
  return `${p} ${rw}`;
}

export function renderToolCall(name: string, args: any, theme: Theme, width?: number): string {
  let text = theme.fg('toolTitle', name);
  if (args.task) {
    const task = typeof args.task === 'string' ? args.task : JSON.stringify(args.task);
    const preview = task.length > 50 ? task.slice(0, 47) + '...' : task;
    text += ' ' + theme.fg('dim', preview);
  } else if (args.tasks && Array.isArray(args.tasks)) {
    text += theme.fg('accent', ` (${args.tasks.length} parallel)`);
  }
  if (width) {
    return truncateToWidth(text, width);
  }
  return text;
}

/** ANSI safe width */
export function safeWidth(text: string): number {
  return visibleWidth(text);
}

/** Status line preview (metadata only, not full summary) */
export function formatStatusPreview(snapshot: RunSnapshot, now = Date.now()): string {
  const active = snapshot.state === 'running' ? 1 : 0;
  const done = snapshot.delivered ? 'delivered' : 'ready';
  const elapsed = formatElapsed(snapshot.startedAt, now);
  return `[${snapshot.id.slice(0, 8)}] ${snapshot.mode} ${formatState(snapshot.state)} ${elapsed} ${done}`;
}

export interface RenderOptions {
  expanded?: boolean;
  theme: Theme;
  width: number;
  keyHint?: string;
  liveText?: string;
  spinnerFrame?: number;
}

/** Render call for single task - returns lines or TUI component */
export function renderCall(spec: any, opts: RenderOptions): string[] {
  const { expanded = false, theme, width, keyHint } = opts;
  const lines: string[] = [];
  const title = theme.bold(theme.fg('toolTitle', 'subagent ' + (spec.mode || 'single')));
  lines.push(truncateToWidth(title, width));

  if (spec.task) {
    const taskLine = theme.fg('dim', 'Task: ') + truncateToWidth(spec.task, width - 7);
    lines.push(taskLine);
  }
  if (spec.tasks && Array.isArray(spec.tasks)) {
    lines.push(theme.fg('accent', `${spec.tasks.length} parallel tasks`));
    if (!expanded) {
      spec.tasks.slice(0, 3).forEach((t: any, i: number) => {
        const line = `  ${i+1}. ` + renderToolCall(t.agent || 'task', t, theme, width - 5);
        lines.push(line);
      });
      if (spec.tasks.length > 3) lines.push(theme.fg('muted', `  ... +${spec.tasks.length - 3}`));
    }
  }
  if (keyHint) {
    lines.push(theme.fg('muted', keyHint));
  }
  return lines.map(l => truncateToWidth(l, width));
}

/** Render result for task, supports expanded live parallel */
export function renderResult(result: TaskResult | RunSnapshot, opts: RenderOptions): string[] {
  const { expanded = false, theme, width, liveText, spinnerFrame = 0 } = opts;
  const lines: string[] = [];
  const isSnapshot = 'mode' in result && 'results' in result;
  const isRunning = (result.state === 'running' as RunState) || !!(result as any).liveText;
  const spinner = isRunning ? SPINNERS[spinnerFrame % SPINNERS.length] : '✓';
  const stateStr = formatState((result.state || 'completed') as RunState);
  const label = isSnapshot ? (result as RunSnapshot).id?.slice(0, 8) || 'subagent' : (result as TaskResult).label || 'subagent';

  let header = `${spinner} ${theme.fg('toolTitle', label)}`;
  const model = (result as any).model;
  if (model) header += theme.fg('muted', ` @${model}`);
  header += ` ${theme.fg(isRunning ? 'warning' : (stateStr.includes('fail') ? 'error' : 'success'), stateStr)}`;
  lines.push(truncateToWidth(header, width));

  const started = (result as any).startedAt;
  const elapsed = formatElapsed(started || (result as any).endedAt);
  const usage = 'usage' in result && result.usage ? formatUsage(result.usage as UsageStats, model) : '';
  lines.push(theme.fg('dim', `${elapsed} ${usage}`.trim()));

  if (liveText) {
    lines.push(theme.fg('toolOutput', liveText));
  }

  if (expanded) {
    if ('task' in result && typeof (result as any).task === 'string') {
      lines.push('');
      lines.push(theme.fg('muted', 'Task:'));
      const taskStr = String((result as any).task || '');
      const wrappedTask = wrapTextWithAnsi(taskStr, width - 2);
      const taskLines = String(wrappedTask).split('\n');
      taskLines.forEach((l: string) => lines.push('  ' + truncateToWidth(l, width - 2)));
    }
    if ('summary' in result && (result as RunSnapshot).summary) {
      lines.push('');
      lines.push(theme.fg('muted', 'Summary:'));
      lines.push(truncateToWidth((result as RunSnapshot).summary!, width));
    }
  }

  if ('outputFile' in result && (result as any).outputFile) {
    lines.push(theme.fg('muted', '→ Output: ') + formatPath((result as any).outputFile));
  }
  if ('sessionId' in result && (result as any).sessionId) {
    lines.push(theme.fg('muted', 'Session: ') + String((result as any).sessionId).slice(0, 8));
  }

  // Collapsed parallel: one line per task
  if (!expanded && isSnapshot && Array.isArray((result as RunSnapshot).results)) {
    const tasks = (result as RunSnapshot).results || [];
    if (tasks.length > 0) {
      lines.push('');
      lines.push(theme.fg('muted', `Parallel tasks (${tasks.length}):`));
      tasks.slice(0, 5).forEach((t: any, i: number) => {
        const tstate = formatState(t.state || 'completed');
        const tline = `  ${i+1}. ${t.label || t.task?.slice(0, 25) || 'task'} ${tstate}`;
        lines.push(truncateToWidth(tline, width));
      });
    }
  }

  return lines.map(l => truncateToWidth(l, width));
}
