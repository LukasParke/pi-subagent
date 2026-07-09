import type { Message, Usage } from '@earendil-works/pi-ai';
import type { UsageStats, TaskResult } from './types.js';

/**
 * Typed line-buffered parser for Pi JSON mode (--mode json).
 *
 * Protocol events:
 * - session header: { type: "session", id: string } — required for success.
 * - message_update: live assistant text deltas (concatenated for liveText).
 * - message_end: full message with usage; updates turns/cost after each assistant turn. Multiple text parts concatenated.
 * - agent_end: final signal.
 *
 * Success requires: session header + at least one assistant message_end.
 * Exit 0 without these is treated as protocol failure.
 *
 * Malformed lines are counted but do not fail the parse.
 * All assistant text parts are concatenated into final output.
 */
export class ProtocolParser {
  private buffer = '';
  private sessionId: string | null = null;
  private messages: Message[] = [];
  private usage: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  private liveText = '';
  private parseErrors = 0;
  private validEvents = 0;
  private headerSeen = false;
  private assistantEndSeen = false;
  private agentEndSeen = false;
  private model: string | undefined = undefined;
  private stopReason: string | undefined = undefined;
  private errorMessage: string | undefined = undefined;

  /**
   * Feed data (stdout chunk). Processes complete lines.
   * Returns updates for checkpoint/progress callback on header, message_update, message_end/usage.
   */
  feed(data: Buffer | string): {
    liveTextDelta?: string;
    usageUpdate?: Partial<UsageStats>;
    newMessage?: Message;
    sessionId?: string;
  } | null {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    let update: any = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: any;
      try {
        event = JSON.parse(trimmed);
        this.validEvents++;
      } catch {
        this.parseErrors++;
        continue;
      }

      if (event.type === 'session' && typeof event.id === 'string') {
        this.sessionId = event.id;
        this.headerSeen = true;
        update = { sessionId: event.id };
      } else if (event.type === 'message_update' && event.message?.role === 'assistant') {
        const textParts = this.extractTextParts(event.message);
        const delta = textParts.join('\n');
        if (delta) {
          this.liveText += delta;
          update = { liveTextDelta: delta };
        }
      } else if (event.type === 'message_end' && event.message) {
        const msg = event.message as Message;
        this.messages.push(msg);

        if (msg.role === 'assistant') {
          this.assistantEndSeen = true;
          this.usage.turns++;
          const u = msg.usage as Usage | undefined;
          if (u) {
            this.usage.input += u.input || 0;
            this.usage.output += u.output || 0;
            this.usage.cacheRead += (u as any).cacheRead || 0;
            this.usage.cacheWrite += (u as any).cacheWrite || 0;
            this.usage.cost += (u.cost as any)?.total || u.cost || 0;
            this.usage.contextTokens = u.totalTokens || this.usage.contextTokens;
          }
          if (!this.model && msg.model) this.model = msg.model;
          if (msg.stopReason) this.stopReason = msg.stopReason;
          if ((msg as any).errorMessage) this.errorMessage = (msg as any).errorMessage;

          const textParts = this.extractTextParts(msg);
          const text = textParts.join(' ');
          if (text) this.liveText = text; // final overrides live
          update = { newMessage: msg, usageUpdate: { ...this.usage } };
        } else {
          update = { newMessage: msg };
        }
      } else if (event.type === 'agent_end') {
        this.agentEndSeen = true;
      }
    }

    return update;
  }

  private extractTextParts(msg: Message): string[] {
    if (!msg.content || !Array.isArray(msg.content)) return [];
    return msg.content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text);
  }

  /**
   * Finalize and return structured result.
   * Protocol is successful only if headerSeen && assistantEndSeen.
   */
  finalize(exitCode: number | null, signal?: NodeJS.Signals, stderr = ''): TaskResult {
    const protocol = {
      headerSeen: this.headerSeen,
      assistantEndSeen: this.assistantEndSeen,
      agentEndSeen: this.agentEndSeen,
      validEvents: this.validEvents,
      parseErrors: this.parseErrors,
    };

    const success = this.headerSeen && this.assistantEndSeen;

    let state: any = success ? 'completed' : 'failed';
    let exit = exitCode ?? (signal ? null : 1);
    let stopR = this.stopReason || (success ? 'stop' : 'protocol_error');
    if (signal) {
      state = 'cancelled';
      stopR = 'cancelled';
    } else if (exitCode === 0 && !success) {
      exit = 1;
      stopR = 'protocol_error';
    }

    return {
      label: 'subagent',
      task: '', // filled by runner
      state,
      exitCode: exit,
      signal,
      messages: [...this.messages],
      stderr,
      usage: { ...this.usage },
      model: this.model,
      stopReason: stopR,
      errorMessage: this.errorMessage,
      liveText: this.liveText || undefined,
      protocol,
      sessionId: this.sessionId || undefined,
    };
  }

  getLiveText(): string {
    return this.liveText;
  }
}
