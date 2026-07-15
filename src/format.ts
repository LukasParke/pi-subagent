import type { UsageStats, RunSnapshot, RunState, RunMode, TimeoutPhase } from './types.js';
import type { Theme } from '@earendil-works/pi-coding-agent';
import * as os from 'node:os';
import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

/**
 * Formatting helpers for pi-subagent UI.
 * ANSI-safe, respects terminal width, supports spinners, elapsed, etc.
 * Independent of runner/registry.
 */

export const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const ACTIVE_STATES: ReadonlySet<string> = new Set(['queued', 'running']);

export function isActiveState(state: string | undefined): boolean {
  return state !== undefined && ACTIVE_STATES.has(state);
}

/** Collapse whitespace/newlines into a single display line. */
export function oneLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, Math.max(0, max - 1))}…` : collapsed;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}

export function formatElapsed(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '0s';
  return formatDuration(Math.max(0, now - ms));
}

export function formatTokens(n: number | undefined): string {
  if (!n || n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export function formatCost(cost: number): string {
  if (cost >= 0.095) return `$${cost.toFixed(2)}`;
  if (cost >= 0.00095) return `$${cost.toFixed(3)}`;
  return '<$0.001';
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
    case 'completed': return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'queued': return 'queued';
    case 'partial': return 'partial';
    case 'lost': return 'lost';
    case 'timeout': return 'timeout';
    default: return state;
  }
}

/** Single-cell themed state glyph. Running states animate via spinnerFrame. */
export function stateGlyph(state: RunState | undefined, theme: Theme, spinnerFrame = 0): string {
  switch (state) {
    case 'queued': return theme.fg('dim', '◌');
    case 'running': return theme.fg('accent', SPINNERS[spinnerFrame % SPINNERS.length]!);
    case 'completed': return theme.fg('success', '✓');
    case 'partial': return theme.fg('warning', '◐');
    case 'cancelled': return theme.fg('muted', '−');
    case 'timeout': return theme.fg('warning', '◷');
    case 'lost': return theme.fg('error', '?');
    case 'failed': return theme.fg('error', '✗');
    default: return theme.fg('dim', '·');
  }
}

/** Status line preview (metadata only, not full summary). Duration freezes at endedAt. */
export function formatStatusPreview(snapshot: RunSnapshot, now = Date.now()): string {
  const done = snapshot.delivered ? 'delivered' : snapshot.resumeBlocked ? 'blocked' : 'ready';
  const elapsed = formatElapsed(snapshot.startedAt, snapshot.endedAt ?? now);
  const phase = snapshot.results.find((r) => r.timeoutPhase)?.timeoutPhase;
  const phaseTag = snapshot.state === 'timeout' && phase ? `/${phase}` : '';
  return `[${snapshot.id.slice(0, 8)}] ${snapshot.mode} ${formatState(snapshot.state)}${phaseTag} ${elapsed} ${done}`;
}

// ── Inline tool-block rendering ─────────────────────────────────────────────
//
// Pi's tool shell (Box) already paints pending/success/error backgrounds and
// state, so inline blocks stay compact: a stats line plus a `⎿ activity`
// line, fixed height while streaming, mutating in place.

export interface InlineTaskView {
  label?: string;
  state?: RunState;
  usage?: Partial<UsageStats>;
  model?: string;
  stopReason?: string;
  timeoutPhase?: TimeoutPhase;
  errorMessage?: string;
  finalOutput?: string;
  outputFile?: string;
  sessionId?: string;
  worktree?: { cwd: string; branch: string };
  wrappedUp?: boolean;
  stalledSince?: number;
  attempts?: number;
  structuredOutput?: unknown;
  structuredError?: string;
}

export interface InlineRunView {
  mode: RunMode;
  state?: RunState;
  startedAt?: number;
  endedAt?: number;
  results: InlineTaskView[];
}

export interface InlineRenderOptions {
  theme: Theme;
  width: number;
  expanded?: boolean;
  isPartial?: boolean;
  spinnerFrame?: number;
  now?: number;
}

interface AggregateStats { turns: number; tokens: number; cost: number }

function usageAggregate(results: InlineTaskView[]): AggregateStats {
  let turns = 0, tokens = 0, cost = 0;
  for (const r of results) {
    turns += r.usage?.turns ?? 0;
    tokens += (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
    cost += r.usage?.cost ?? 0;
  }
  return { turns, tokens, cost };
}

function statsText(agg: AggregateStats, durationMs?: number): string {
  const parts: string[] = [];
  if (agg.turns > 0) parts.push(`↻${agg.turns}`);
  if (agg.tokens > 0) parts.push(`${formatTokens(agg.tokens)} tok`);
  if (agg.cost > 0.00005) parts.push(formatCost(agg.cost));
  if (durationMs !== undefined && durationMs >= 0) parts.push(formatDuration(durationMs));
  return parts.join(' · ');
}

function taskAnnotations(task: InlineTaskView, now: number): string[] {
  const notes: string[] = [];
  if (task.attempts && task.attempts > 1) notes.push(`attempt ${task.attempts}`);
  if (task.stalledSince && isActiveState(task.state)) notes.push(`stalled ${formatDuration(now - task.stalledSince)}`);
  if (!isActiveState(task.state)) {
    if (task.structuredOutput !== undefined) notes.push('✓ schema');
    else if (task.structuredError) notes.push('schema ✗');
  }
  return notes;
}

function pickLine(text: string | undefined, which: 'first' | 'last'): string | undefined {
  if (!text) return undefined;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  return which === 'last' ? lines[lines.length - 1] : lines[0];
}

/** One-line collapsed call header: `subagent <preview>`. */
export function renderCallLine(args: any, theme: Theme, width: number): string {
  const title = theme.fg('toolTitle', theme.bold('subagent'));
  let preview = '';
  if (args?.action) {
    preview = `${args.action}${args.id ? ` ${String(args.id).slice(0, 8)}` : ''}`;
  } else if (Array.isArray(args?.tasks)) {
    const first = args.tasks[0]?.task;
    preview = `${args.tasks.length} parallel tasks${first ? ` — ${oneLine(String(first), 60)}` : ''}`;
  } else if (args?.resume) {
    preview = `resume ${String(args.resume).slice(0, 8)}${args.task ? ` — ${oneLine(String(args.task))}` : ''}`;
  } else if (args?.task) {
    preview = oneLine(String(args.task));
  }
  const tag = args?.async ? ` ${theme.fg('accent', '· background')}` : '';
  return truncateToWidth(`${title} ${theme.fg('muted', preview)}${tag}`, width);
}

function wrapLines(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, Math.max(10, width));
  return Array.isArray(wrapped) ? wrapped : String(wrapped).split('\n');
}

type ThemeColor = Parameters<Theme['fg']>[0];

function terminalTaskLine(theme: Theme, task: InlineTaskView): { text: string; color: ThemeColor } | undefined {
  switch (task.state) {
    case 'failed':
    case 'lost':
      return { text: `${formatState(task.state)} — ${oneLine(task.errorMessage ?? task.stopReason ?? 'unknown error')}`, color: 'error' };
    case 'cancelled':
      return { text: 'cancelled', color: 'muted' };
    case 'timeout':
      return { text: `timed out${task.timeoutPhase ? ` (${task.timeoutPhase})` : ''}`, color: 'warning' };
    case 'partial': {
      if (task.wrappedUp) {
        const first = pickLine(task.finalOutput, 'first');
        return { text: `wrapped up (${(task.stopReason ?? 'budget').replace('_', ' ')})${first ? ` — ${oneLine(first, 80)}` : ''}`, color: 'warning' };
      }
      if (task.stopReason === 'stalled') {
        return { text: `stalled — ${oneLine(task.errorMessage ?? 'no activity', 80)}`, color: 'warning' };
      }
      const first = pickLine(task.finalOutput, 'first');
      return first ? { text: oneLine(first), color: 'toolOutput' } : undefined;
    }
    default: {
      const first = pickLine(task.finalOutput, 'first');
      return first ? { text: oneLine(first), color: 'toolOutput' } : undefined;
    }
  }
}

function pointerText(task: InlineTaskView, expanded: boolean): string | undefined {
  const parts: string[] = [];
  if (task.outputFile) parts.push(`→ ${formatPath(task.outputFile)}`);
  if (task.worktree) parts.push(`⎇ ${task.worktree.branch}`);
  if (expanded && task.sessionId) parts.push(`session ${task.sessionId.slice(0, 8)}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function expandedOutputLines(theme: Theme, task: InlineTaskView, width: number, cap: number): string[] {
  if (!task.finalOutput) return [];
  const lines: string[] = [''];
  const wrapped = wrapLines(task.finalOutput, width - 2);
  for (const line of wrapped.slice(0, cap)) lines.push(`  ${theme.fg('toolOutput', line)}`);
  if (wrapped.length > cap) {
    lines.push(theme.fg('dim', `  … +${wrapped.length - cap} lines (full output in ${task.outputFile ? formatPath(task.outputFile) : 'the child session'})`));
  }
  return lines;
}

/**
 * Compact run block. Fixed shape while streaming:
 *   ⠹ ↻3 · 12.4k tok · 8s
 *     ⎿ reading src/auth/middleware.ts…
 * Terminal:
 *   ↻8 · 33.8k tok · $0.012 · 12s
 *     ⎿ Found 5 middleware call sites…
 * Parallel collapsed: one line per task.
 */
export function renderRunLines(run: InlineRunView, opts: InlineRenderOptions): string[] {
  const { theme, width } = opts;
  const now = opts.now ?? Date.now();
  const frame = opts.spinnerFrame ?? 0;
  const running = opts.isPartial ?? isActiveState(run.state);
  const durationMs = run.startedAt ? (run.endedAt ?? now) - run.startedAt : undefined;
  const agg = usageAggregate(run.results);
  const stats = statsText(agg, durationMs);
  const spin = theme.fg('accent', SPINNERS[frame % SPINNERS.length]!);
  const lines: string[] = [];

  if (run.mode === 'parallel' && run.results.length > 1) {
    const total = run.results.length;
    const done = run.results.filter((r) => r.state && !isActiveState(r.state)).length;
    lines.push(running
      ? `${spin} ${theme.fg('dim', `${done}/${total} done${stats ? ` · ${stats}` : ''}`)}`
      : theme.fg('dim', `${total} tasks${stats ? ` · ${stats}` : ''}`));

    const shown = opts.expanded ? run.results : run.results.slice(0, 6);
    for (const task of shown) {
      const glyph = stateGlyph(task.state, theme, frame);
      const mini = statsText(usageAggregate([task]));
      const active = isActiveState(task.state);
      // The state glyph already communicates the outcome; parallel rows show
      // just the message/preview without repeating the state word.
      const tail = active
        ? pickLine(task.finalOutput, 'last')
        : ['failed', 'lost'].includes(task.state ?? '')
          ? (task.errorMessage ?? task.stopReason ?? formatState(task.state!))
          : task.state === 'timeout'
            ? `timed out${task.timeoutPhase ? ` (${task.timeoutPhase})` : ''}`
            : task.state === 'cancelled'
              ? undefined
              : pickLine(task.finalOutput, 'first');
      const tailColor: ThemeColor = !active && ['failed', 'lost'].includes(task.state ?? '') ? 'error' : 'muted';
      let line = `  ${glyph} ${theme.fg('text', task.label ?? 'task')}`;
      if (mini) line += theme.fg('dim', ` · ${mini}`);
      const notes = taskAnnotations(task, now);
      if (notes.length) line += ` ${theme.fg('warning', `[${notes.join(' · ')}]`)}`;
      if (task.wrappedUp && !active) line += ` ${theme.fg('warning', '◐ wrapped up')}`;
      if (tail) line += ` ${theme.fg(tailColor, `— ${oneLine(tail, 80)}`)}`;
      lines.push(line);
      if (opts.expanded) {
        const pointers = pointerText(task, true);
        if (pointers) lines.push(theme.fg('dim', `    ${pointers}`));
        lines.push(...expandedOutputLines(theme, task, width, 12).map((l) => l ? `  ${l}` : l));
      }
    }
    if (!opts.expanded && total > shown.length) {
      lines.push(theme.fg('dim', `  … +${total - shown.length} more`));
    }
  } else {
    const task = run.results[0] ?? {};
    if (running) {
      const notes = taskAnnotations(task, now);
      const noteText = notes.length ? ` ${theme.fg('warning', `[${notes.join(' · ')}]`)}` : '';
      lines.push(`${spin} ${theme.fg('dim', stats || 'starting…')}${noteText}`);
      const activity = pickLine(task.finalOutput, 'last');
      if (activity) lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg('muted', oneLine(activity, width))}`);
    } else {
      lines.push(theme.fg('dim', stats || formatState(run.state ?? task.state ?? 'completed')));
      const summary = terminalTaskLine(theme, task);
      if (summary && !opts.expanded) lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg(summary.color, oneLine(summary.text, width))}`);
      const pointers = pointerText(task, opts.expanded ?? false);
      if (pointers) lines.push(theme.fg('dim', `  ${pointers}`));
      if (opts.expanded) {
        if (summary && ['error', 'warning', 'muted'].includes(summary.color)) {
          lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg(summary.color, oneLine(summary.text, width))}`);
        }
        lines.push(...expandedOutputLines(theme, task, width, 40));
      }
    }
  }

  return lines.map((line) => truncateToWidth(line, width));
}
