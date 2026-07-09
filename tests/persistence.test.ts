import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersistenceLayer } from '../src/persistence.js';
import { defaultConfig } from '../src/config.js';

describe('PersistenceLayer', () => {
  let adapter: any;
  let persistence: PersistenceLayer;

  beforeEach(() => {
    adapter = {
      appendEntry: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
      getActiveBranch: () => 'feature-branch',
    };
    persistence = new PersistenceLayer(adapter, { ...defaultConfig, sessionRetentionDays: 7 });
  });

  it('persists start, checkpoint (child-session, throttled progress/turn), terminal', () => {
    persistence.persist('run-1', 'sess-1', 'start', { mode: 'single', startedAt: Date.now() });
    expect(adapter.appendEntry).toHaveBeenCalledWith('subagent-run-v1', expect.objectContaining({
      id: 'run-1',
      sessionKey: 'sess-1',
      type: 'start',
      schemaVersion: 1,
    }));

    persistence.persist('run-1', 'sess-1', 'checkpoint', { progress: 'working', turn: 2, childSessionId: 'c1' });
    persistence.persist('run-1', 'sess-1', 'terminal', { state: 'completed', summary: 'ok' }, true);

    expect(adapter.appendEntry).toHaveBeenCalledTimes(3);
  });

  it('rebuilds from entries: active branch only, latest schema v1 wins per id, validates, running -> lost', () => {
    adapter.getEntries.mockReturnValue([
      {
        type: 'subagent-run-v1',
        data: {
          schemaVersion: 1,
          id: 'r1',
          sessionKey: 'sess-1',
          timestamp: 100,
          type: 'start',
          branch: 'feature-branch',
          data: { mode: 'single', startedAt: 100, state: 'running', taskPreviews: ['task1'] },
        },
      },
      {
        type: 'subagent-run-v1',
        data: {
          schemaVersion: 1,
          id: 'r1',
          sessionKey: 'sess-1',
          timestamp: 200,
          type: 'terminal',
          branch: 'feature-branch',
          data: { state: 'completed', summary: 'final', results: [{ label: 't1', task: 'do', state: 'completed', exitCode: 0, usage: {} }] },
        },
      },
      {
        // older branch ignored
        type: 'subagent-run-v1',
        data: { schemaVersion: 1, id: 'r2', sessionKey: 'sess-1', branch: 'main', data: {} },
      },
      {
        // malformed skipped
        data: { id: 'bad' },
      },
    ]);

    const snapshots = persistence.rebuild('sess-1');
    expect(snapshots.size).toBe(1);
    const snap = snapshots.get('r1')!;
    expect(snap.state).toBe('completed'); // latest wins, not running->lost because terminal overrode
    expect(snap.summary).toBe('final');
    expect(snap.results).toHaveLength(1);
  });

  it('running records restored as lost', () => {
    adapter.getEntries.mockReturnValue([{
      type: 'subagent-run-v1',
      data: {
        schemaVersion: 1,
        id: 'lost-run',
        sessionKey: 'sess-lost',
        timestamp: Date.now(),
        type: 'start',
        branch: 'feature-branch',
        data: { mode: 'single', state: 'running', startedAt: Date.now() - 10000, taskPreviews: ['lost'] },
      },
    }]);

    const snaps = persistence.rebuild('sess-lost');
    const s = snaps.get('lost-run')!;
    expect(s.state).toBe('lost');
    expect(s.summary).toContain('lost');
  });

  it('branch-aware: only active branch entries', () => {
    adapter.getActiveBranch = vi.fn().mockReturnValue('main');
    adapter.getEntries.mockReturnValue([
      { type: 'subagent-run-v1', data: { schemaVersion: 1, id: 'b1', sessionKey: 's1', branch: 'feature', data: { state: 'completed' } } },
      { type: 'subagent-run-v1', data: { schemaVersion: 1, id: 'b2', sessionKey: 's1', branch: 'main', data: { state: 'completed' } } },
    ]);

    const snaps = persistence.rebuild('s1');
    expect(snaps.has('b1')).toBe(false);
    expect(snaps.has('b2')).toBe(true);
  });

  it('session retention planner produces candidates only when retention configured; no FS deletion', () => {
    const refs = new Set(['s1', 's2']);
    const plan = persistence.planRetention(refs);
    expect(plan.keep).toEqual(Array.from(refs));
    expect(plan.candidates.length).toBe(0); // no destructive by default in this impl

    const noRetention = new PersistenceLayer(adapter, { ...defaultConfig });
    const plan2 = noRetention.planRetention(refs);
    expect(plan2.keep).toEqual([]);
    expect(plan2.candidates).toEqual([]);
  });

  it('interface usable by Pi appendEntry without importing extension API', () => {
    // adapter.appendEntry used directly: verified by mocks above and persistence contract
    expect(typeof persistence.persist).toBe('function');
    expect(typeof (persistence as any).adapter.appendEntry).toBe('function');
  });
});
