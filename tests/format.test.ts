import { describe, it, expect } from 'vitest';
import * as format from '../src/format.js';
import type { UsageStats, RunSnapshot, RunState } from '../src/types.js';

describe('format helpers', () => {
  it('formats elapsed time', () => {
    const now = Date.now();
    expect(format.formatElapsed(0, now)).toBe('0s');
    expect(format.formatElapsed(now - 30000, now)).toBe('30s');
    expect(format.formatElapsed(now - 125000, now)).toBe('2m5s');
  });

  it('formats tokens compactly', () => {
    expect(format.formatTokens(0)).toBe('0');
    expect(format.formatTokens(500)).toBe('500');
    expect(format.formatTokens(1500)).toBe('1.5k');
    expect(format.formatTokens(2500000)).toBe('2.5M');
  });

  it('formats usage stats', () => {
    const usage: UsageStats = {
      input: 1024,
      output: 512,
      cacheRead: 100,
      cacheWrite: 50,
      cost: 0.0123,
      contextTokens: 8096,
      turns: 3,
    };
    const formatted = format.formatUsage(usage);
    expect(formatted).toContain('3t');
    expect(formatted).toContain('↑1.0k'); // due to toFixed(1)
    expect(formatted).toContain('$0.0123');
  });

  it('formats paths safely', () => {
    expect(format.formatPath('/Users/luke/test/file.txt')).toContain('~');
    expect(format.formatPath('/very/long/path/that/should/be/truncated/for/display')).toMatch(/^\.\.\./);
  });

  it('renders tool call and result with width safety', () => {
    const theme = { fg: (c: string, t: string) => t, bold: (t: string) => t } as any;
    const callLines = format.renderCall({ task: 'Implement UI for subagent with parallel support' }, {
      theme,
      width: 60,
    });
    expect(callLines.length).toBeGreaterThan(0);
    expect(callLines[0]).toContain('subagent');

    const result: RunSnapshot = {
      schemaVersion: 1,
      id: 'test-123',
      sessionKey: 'sess',
      mode: 'single',
      state: 'completed' as RunState,
      startedAt: Date.now() - 45000,
      taskPreviews: ['preview'],
      delivered: true,
      results: [],
    };
    const resultLines = format.renderResult(result, { theme, width: 50 });
    expect(resultLines.some((l: string) => l.includes('done') || l.includes('completed') || l.includes('✓'))).toBe(true);
  });

  it('status preview is metadata only', () => {
    const snap: RunSnapshot = {
      schemaVersion: 1 as const,
      id: 'abc123456789',
      sessionKey: 'key',
      mode: 'parallel' as const,
      state: 'running' as RunState,
      startedAt: Date.now() - 120000,
      taskPreviews: [],
      delivered: false,
      results: [],
    };
    const preview = format.formatStatusPreview(snap);
    expect(preview).toContain('abc12345');
    expect(preview).toContain('parallel');
    expect(preview).not.toContain('full summary'); // metadata/preview
  });
});
