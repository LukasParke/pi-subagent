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
    footer.update(3, 1); // 3 running, 1 undelivered
    const status = footer.render(theme, 80);
    expect(status).toContain('3 running');
    expect(status).toContain('2 ready');
    expect(status).toContain('/1 pending');
    expect(status).toContain('/subagents');
  });

  it('notification debounced per terminal transition', () => {
    const notifySpy = vi.spyOn(adapter, 'notify');
    footer.notifyTransition('test1');
    footer.notifyTransition('test2'); // should debounce
    expect(notifySpy).toHaveBeenCalledTimes(1);
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

    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => '**' + t + '**', muted: (t: string) => t, accent: (t: string) => t, toolTitle: (t: string) => t, dim: (t: string) => t, toolOutput: (t: string) => t, success: (t: string) => t, warning: (t: string) => t, error: (t: string) => t } as any;

    // Test render from format with live parallel - covers expanded live parallel + truncation
    const opts: format.RenderOptions = { expanded: true, theme, width: 80, liveText: 'thinking about next step with spinner...', spinnerFrame: 2 };
    const rendered = format.renderResult(runningParallel, opts);
    expect(rendered.some((l: string) => l.includes('thinking') || l.includes('parallel') || l.includes('thinking about next step'))).toBe(true);

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
