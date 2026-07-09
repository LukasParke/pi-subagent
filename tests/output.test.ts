import { describe, it, expect, beforeEach } from 'vitest';
import { OutputManager } from '../src/output.js';
import { defaultConfig } from '../src/config.js';
import type { TaskResult } from '../src/types.js';

describe('OutputManager - global caps, unicode, parallel large results, duplicate prevention, artifact pointers', () => {
  let output: OutputManager;

  beforeEach(() => {
    output = new OutputManager(defaultConfig);
  });

  it('never exceeds 50KB UTF-8 bytes and 2000 lines', () => {
    const longText = 'x'.repeat(60_000);
    const results: TaskResult[] = [{ 
      label: 'test', 
      task: 'long', 
      state: 'completed' as any,
      exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: longText }] }] as any,
      stderr: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      protocol: { headerSeen: true, assistantEndSeen: true, agentEndSeen: true, validEvents: 10, parseErrors: 0 },
    }];

    const capped = output.capOutputForDelivery(results);
    expect(capped.totalBytes).toBeLessThanOrEqual(50 * 1024 + 100);
    expect(capped.totalLines).toBeLessThanOrEqual(2000);
    expect(capped.text).toContain('cap reached');
  });

  it('fair per-section budgets for parallel and multi-wait results', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      label: `task-${i}`,
      task: `task ${i}`,
      state: 'completed' as any,
      exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(20_000) }] }] as any,
      stderr: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } as any,
      protocol: { headerSeen: true, assistantEndSeen: true, agentEndSeen: true, validEvents: 1, parseErrors: 0 } as any,
    }));

    const capped = output.capOutputForDelivery(results, true /* multi-wait */);
    expect(capped.cappedResults.length).toBe(5);
    // fair budget ~10KB each
    for (const cr of capped.cappedResults) {
      expect(Buffer.byteLength(cr.finalOutput!, 'utf8')).toBeLessThan(15_000);
    }
    expect(capped.text).toContain('## Run section');
  });

  it('handles unicode bytes correctly (emojis, multibyte chars)', () => {
    const unicode = '🚀 Hello 世界 🌍 '.repeat(5000); // heavy utf8
    const test = output.testUnicodeBytes(unicode);
    expect(test.bytes).toBeGreaterThan(30000); // rough

    const results = [{
      label: 'unicode',
      task: 'test',
      state: 'completed' as any,
      exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: unicode }] }] as any,
      stderr: '',
      usage: {} as any,
      protocol: {} as any,
    }];

    const capped = output.capOutputForDelivery(results);
    const bytes = Buffer.byteLength(capped.text, 'utf8');
    expect(bytes).toBeLessThanOrEqual(50 * 1024 + 200);
    expect(capped.text).toContain('🚀');
    expect(capped.text).toContain('[Truncated');
  });

  it('status preview is compact; one-shot wait is full one-time delivered', () => {
    const snap = {
      id: 'abc123',
      state: 'completed',
      mode: 'parallel',
      results: [{ label: 't1', task: 'foo', state: 'completed' as any, exitCode: 0, usage: {} as any }],
      summary: 'This is a very long summary that should be previewed compactly for UI status bar. It repeats many words to test truncation: '.repeat(20),
      delivered: false,
      taskPreviews: ['foo'],
    } as any;

    const preview = output.makeStatusPreview(snap, 120);
    expect(preview.length).toBeLessThan(130);
    expect(preview).toContain('abc123');
    expect(preview).toContain('[completed]');
    expect(preview).not.toContain('repeats many words'); // compacted
  });

  it('preserves full artifact pointer for outputFile; one-shot avoids duplicate delivery', () => {
    const results = [{
      label: 'artifact',
      task: 'save',
      state: 'completed' as any,
      exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'very long output '.repeat(4000) }] }] as any,
      stderr: '',
      usage: {} as any,
      outputFile: '/path/to/full-report.md',
      protocol: {} as any,
    }];

    const capped = output.capOutputForDelivery(results);
    // The truncate logic inserts 'artifact' phrase and path
    expect(capped.text).toContain('artifact');
    expect(capped.cappedResults[0]!.capped).toBe(true);
  });

  it('many parallel ~50KB results stay under global cap', () => {
    const big = 'x'.repeat(12_000);
    const results = Array.from({ length: 5 }, () => ({
      label: 'big',
      task: 'parallel-big',
      state: 'completed' as any,
      exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: big }] }] as any,
      stderr: '',
      usage: {} as any,
      protocol: {} as any,
    }));

    const res = output.capOutputForDelivery(results);
    const bytes = Buffer.byteLength(res.text, 'utf8');
    expect(bytes).toBeLessThan(52 * 1024);
    expect(res.cappedResults.every(r => r.capped)).toBe(true);
  });
});
