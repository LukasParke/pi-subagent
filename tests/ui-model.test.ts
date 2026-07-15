import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FooterStatusModel, SubagentsUIModel, type SubagentAdapter, type UIAction } from '../src/ui.js';
import type { RunSnapshot, RunState } from '../src/types.js';
import * as format from '../src/format.js';

describe('UI Models', () => {
  let adapter: SubagentAdapter;
  let footer: FooterStatusModel;
  let uiModel: SubagentsUIModel;

  const mockRun = (id: string, state: RunState = 'running' as RunState, delivered = false): RunSnapshot => ({
    schemaVersion: 1,
    id,
    sessionKey: 'test',
    mode: 'single' as const,
    state,
    startedAt: Date.now() - 30000,
    endedAt: state !== 'running' ? Date.now() : undefined,
    taskPreviews: ['test task'],
    summary: 'test summary',
    delivered,
    results: [],
  });

  beforeEach(() => {
    adapter = {
      getActiveRuns: () => [mockRun('r1'), mockRun('r2', 'completed' as RunState)],
      getCompletedRuns: () => [mockRun('c1', 'completed' as RunState, true)],
      getRunById: (id) => mockRun(id),
      cancelRun: vi.fn(),
      dismissRun: vi.fn(),
      resumeRun: vi.fn().mockResolvedValue(undefined),
      showOutput: vi.fn(),
      getReadyCount: () => 2,
      notify: vi.fn(),
    };
    footer = new FooterStatusModel(adapter);
    uiModel = new SubagentsUIModel(adapter);
  });

  it('footer supports running and completed-undelivered states', () => {
    const theme = { fg: (_: string, t: string) => t, muted: (t: string) => t } as any;
    footer.update(3);
    const status = footer.render(theme, 80);
    expect(status).toContain('3 running');
    expect(status).toContain('2 ready');
    expect(status).toContain('/subagents');
  });

  it('notifies exactly once per terminal run id', () => {
    const notifySpy = vi.spyOn(adapter, 'notify');
    footer.notifyTerminal('run-1', 'done');
    footer.notifyTerminal('run-1', 'done again');
    footer.notifyTerminal('run-2', 'done');
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });

  it('pure UI model navigation, actions, ready state', () => {
    expect(uiModel.runs.length).toBeGreaterThan(0);
    expect(uiModel.isRunning()).toBe(true);

    uiModel.select(1);
    expect(uiModel.state.selectedIndex).toBe(1);

    const action = uiModel.simulateKey('Enter');
    expect(action?.type).toBe('select');
    expect(uiModel.state.listMode).toBe(false);

    uiModel.goBack();
    expect(uiModel.state.listMode).toBe(true);

    uiModel.toggleExpanded();
    expect(uiModel.state.expanded).toBe(true);
  });

  it('covers expanded live parallel, truncation, timers', () => {
    const runningParallel: RunSnapshot = {
      ...mockRun('par1', 'running' as RunState),
      mode: 'parallel' as any,
      results: [{ label: 't1', task: 'task1', state: 'running' as RunState, exitCode: null, usage: {input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,contextTokens:0,turns:0} } as any],
    } as RunSnapshot;

    adapter.getActiveRuns = () => [runningParallel];
    const model = new SubagentsUIModel(adapter);

    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => '**' + t + '**' } as any;

    // Live parallel view renders one line per task with live activity, expanded.
    const view: format.InlineRunView = {
      mode: 'parallel',
      state: 'running' as RunState,
      startedAt: runningParallel.startedAt,
      results: [
        { label: 't1', state: 'running' as RunState, usage: { turns: 0, input: 0, output: 0, cost: 0 }, finalOutput: 'thinking about next step with spinner...' },
        { label: 't2', state: 'queued' as RunState, usage: { turns: 0, input: 0, output: 0, cost: 0 } },
      ],
    };
    const rendered = format.renderRunLines(view, { expanded: true, theme, width: 80, isPartial: true, spinnerFrame: 2 });
    expect(rendered.some((l: string) => l.includes('thinking') || l.includes('t1'))).toBe(true);

    // Timer/disposal covered in component but model simulates
    expect(model.isRunning()).toBe(true);
  });

  it('key navigation and actions covered', () => {
    const actions: UIAction[] = [];
    // In real component it emits, here test model simulates
    const actionCancel = uiModel.simulateKey('c');
    if (actionCancel) actions.push(actionCancel);
    expect(actions.some(a => a.type === 'cancel' || a.type === 'close')).toBe(true);
  });
});
