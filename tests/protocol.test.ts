import { describe, it, expect } from 'vitest';
import { ProtocolParser } from '../src/protocol.js';

describe('ProtocolParser', () => {
  it('parses success with session header, multiple text parts, message_end, agent_end', () => {
    const parser = new ProtocolParser();
    const updates = [];

    updates.push(parser.feed('{"type":"session","id":"s123"}\n'));
    updates.push(parser.feed('{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello "}]}}\n'));
    updates.push(parser.feed('{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"world!"}]}}\n'));
    updates.push(parser.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello world!"}],"usage":{"input":20,"output":10,"cost":{"total":0.002},"totalTokens":30,"stopReason":"stop"}}}\n'));
    updates.push(parser.feed('{"type":"agent_end"}\n'));

    const final = parser.finalize(0);

    expect(final.protocol.headerSeen).toBe(true);
    expect(final.protocol.assistantEndSeen).toBe(true);
    expect(final.protocol.agentEndSeen).toBe(true);
    expect(final.liveText).toBe('Hello world!');
    expect(final.usage.turns).toBe(1);
    expect(final.usage.cost).toBe(0.002);
    expect(final.stopReason).toBe('stop');
    expect(final.sessionId).toBe('s123');
    expect(final.messages.length).toBe(1);
    expect(final.state).toBe('completed');
  });

  it('handles multiple text parts concatenated', () => {
    const parser = new ProtocolParser();
    parser.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Part1"},{"type":"text","text":" Part2"}]}}\n');
    const final = parser.finalize(0);
    expect(final.liveText).toBe('Part1  Part2');
  });

  it('counts malformed lines but continues', () => {
    const parser = new ProtocolParser();
    parser.feed('not json\n');
    parser.feed('{"type":"session","id":"s456"}\n');
    parser.feed('invalid json {\n');
    parser.feed('{"type":"agent_end"}\n');

    const final = parser.finalize(0);
    expect(final.protocol.parseErrors).toBe(2);
    expect(final.protocol.validEvents).toBe(2);
    expect(final.protocol.headerSeen).toBe(true);
    expect(final.state).toBe('failed'); // no assistant end
  });

  it('treats exit 0 without header+assistantEnd as protocol failure', () => {
    const parser = new ProtocolParser();
    parser.feed('{"type":"agent_end"}\n'); // no session or message_end

    const final = parser.finalize(0);
    expect(final.protocol.headerSeen).toBe(false);
    expect(final.protocol.assistantEndSeen).toBe(false);
    expect(final.state).toBe('failed');
    expect(final.exitCode).toBe(1); // changed from 0
    expect(final.stopReason).toBe('protocol_error');
  });

  it('captures usage and model/stopReason from message_end', () => {
    const parser = new ProtocolParser();
    parser.feed('{"type":"session","id":"u789"}\n');
    parser.feed('{"type":"message_end","message":{"role":"assistant","model":"claude-4","content":[{"type":"text","text":"Done"}],"usage":{"input":100,"output":50,"cost":{"total":0.05},"totalTokens":150,"stopReason":"max_tokens"}}}\n');

    const final = parser.finalize(0);
    expect(final.model).toBe('claude-4');
    expect(final.stopReason).toBe('stop');
    expect(final.usage.input).toBe(100);
    expect(final.usage.output).toBe(50);
  });
});
