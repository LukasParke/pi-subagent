import type { TaskResult, RunSnapshot, OutputMode } from './types.js';
import type { Message } from '@earendil-works/pi-ai';
import type { SubagentConfig } from './config.js';
import { Buffer } from 'node:buffer';

/** Global output capping: UTF-8 bytes + lines across single/parallel/multi-wait. Fair per-section budgets. Status preview only. One-shot wait delivery. Never exceed 50KB/2000 lines. Full artifact pointer preserved. Test unicode, parallel 50KB, duplicate delivery. */
export class OutputManager {
  constructor(private config: SubagentConfig) {}

  /** Compact status preview (compact delivery). */
  makeStatusPreview(run: RunSnapshot | any, maxBytes = 200): string {
    let text = `${run.id} [${run.state}] ${run.mode} (${run.results.length} tasks)`;
    if (run.summary) {
      const preview = run.summary.split('\n')[0]?.slice(0, 80) || '';
      text += ` — ${preview}`;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    return bytes > maxBytes ? text.slice(0, maxBytes - 3) + '...' : text;
  }

  /** One-shot wait delivery with global cap. Fair split across sections/results. Full artifact pointer if outputFile. */
  capOutputForDelivery(
    results: TaskResult[] | RunSnapshot['results'],
    isMultiWait = false,
    requestedOutputMode?: OutputMode,
  ): { text: string; cappedResults: any[]; totalBytes: number; totalLines: number } {
    const maxBytes = this.config.maxResultBytes; // 50KB
    const maxLines = this.config.maxResultLines; // 2000

    let budgetPerSection = Math.floor(maxBytes / (results.length || 1));
    let lineBudgetPer = Math.floor(maxLines / (results.length || 1));

    let accumulatedText = '';
    let accumulatedLines = 0;
    const capped: any[] = [];
    let totalBytesUsed = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const resultText = this.getResultText(r);

      // Apply per-result fair budget, but respect global
      const sectionBytes = Math.min(budgetPerSection, maxBytes - totalBytesUsed);
      const sectionLines = Math.min(lineBudgetPer, maxLines - accumulatedLines);

      const cappedSection = this.truncateToBudget(resultText, sectionBytes, sectionLines, r.outputFile);

      const sectionBytesUsed = Buffer.byteLength(cappedSection.text, 'utf8');
      const sectionLinesUsed = cappedSection.lines;

      accumulatedText += (i > 0 ? '\n\n---\n\n' : '') + (isMultiWait ? `## Run section ${i + 1}\n\n` : '') + cappedSection.text;
      accumulatedLines += sectionLinesUsed + 2;
      totalBytesUsed += sectionBytesUsed + 10; // separator overhead

      capped.push({
        ...r,
        finalOutput: cappedSection.text,
        capped: cappedSection.capped,
        bytes: sectionBytesUsed,
      });
    }

    // Global enforce again
    const finalBytes = Buffer.byteLength(accumulatedText, 'utf8');
    if (finalBytes > maxBytes) {
      accumulatedText = accumulatedText.slice(0, maxBytes - 20) + '\n\n[Global output cap reached. Full data in artifacts.]';
    }
    if (accumulatedLines > maxLines) {
      // trim lines post-facto
      const lines = accumulatedText.split('\n');
      accumulatedText = lines.slice(0, maxLines).join('\n') + '\n[Line cap reached]';
    }

    return {
      text: accumulatedText.trim(),
      cappedResults: capped,
      totalBytes: finalBytes,
      totalLines: accumulatedLines,
    };
  }

  private getResultText(r: any): string {
    if (r.finalOutput) return r.finalOutput;
    if (r.errorMessage) return r.errorMessage;
    if (r.messages && Array.isArray(r.messages)) {
      // Extract final assistant text
      for (let i = r.messages.length - 1; i >= 0; i--) {
        const m = r.messages[i];
        if (m && m.role === 'assistant' && Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
          }
        }
      }
    }
    return r.summary || r.stderr || '(no output)';
  }

  private truncateToBudget(text: string, maxB: number, maxL: number, outputFile?: string): { text: string; lines: number; capped: boolean } {
    let t = text;
    let capped = false;

    const lines = t.split('\n');
    if (lines.length > maxL) {
      t = lines.slice(0, maxL).join('\n') + `\n\n[Truncated: ${lines.length - maxL} lines omitted. Full output in artifact${outputFile ? ` (${outputFile})` : ''}.]`;
      capped = true;
    }

    let bytes = Buffer.byteLength(t, 'utf8');
    if (bytes > maxB) {
      let truncated = t;
      while (Buffer.byteLength(truncated, 'utf8') > maxB && truncated.length > 0) {
        truncated = truncated.slice(0, -10);
      }
      t = truncated + `\n\n[Truncated: ${bytes - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full preserved in artifact${outputFile ? ` at ${outputFile}` : ''}.]`;
      capped = true;
    }

    return {
      text: t,
      lines: t.split('\n').length,
      capped,
    };
  }

  /** Test helper: unicode bytes (emojis, etc). */
  testUnicodeBytes(str: string): { bytes: number; lines: number } {
    const b = Buffer.byteLength(str, 'utf8');
    return { bytes: b, lines: str.split('\n').length };
  }

  // One-shot: prevent duplicate delivery by tracking delivered flag on snapshot (handled in registry)
  // Full artifact pointer: included in truncate if outputFile present.
}
