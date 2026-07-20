import { describe, expect, it } from "vitest";
import { ProtocolParser } from "../src/protocol.js";

const header = { type: "session", id: "session-1" };
const message = {
  type: "message_end",
  message: {
    role: "assistant", content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }],
    provider: "p", api: "x", model: "m", stopReason: "stop", timestamp: 1,
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 15, cost: { input: .01, output: .02, cacheRead: .001, cacheWrite: .002, total: .033 } },
  },
};
const end = { type: "agent_end", messages: [] };
const settled = { type: "agent_settled" };

describe("ProtocolParser", () => {
  it("emits every update from a batched chunk", () => {
    const parser = new ProtocolParser();
    const updates = parser.feed([header, { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "hi" } }, message, end, settled].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(updates.map((u) => u.type)).toEqual(["session", "live-text", "message", "agent-end", "agent-settled"]);
  });

  it("flushes a final unterminated JSON line", () => {
    const parser = new ProtocolParser();
    parser.feed(JSON.stringify(header) + "\n" + JSON.stringify(message) + "\n" + JSON.stringify(end) + "\n" + JSON.stringify(settled));
    const result = parser.finalize(0);
    expect(result.state).toBe("completed");
    expect(result.protocol.agentEndSeen).toBe(true);
    expect(result.protocol.agentSettledSeen).toBe(true);
    expect(result.liveText).toBe("hello world");
  });

  it("requires header, assistant message, and settled stream with exit zero", () => {
    const variants = [
      [message, end, settled],
      [header, end, settled],
      [header, message],
    ];
    for (const events of variants) {
      const parser = new ProtocolParser();
      parser.feed(events.map((value) => JSON.stringify(value)).join("\n") + "\n");
      expect(parser.finalize(0).state).not.toBe("completed");
    }
    const nonzero = new ProtocolParser();
    nonzero.feed([header, message, end, settled].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(nonzero.finalize(1)).toMatchObject({ state: "failed", stopReason: "nonzero_exit" });
  });

  it("treats agent_end without agent_settled and without willRetry as legacy settled", () => {
    const parser = new ProtocolParser();
    parser.feed([header, message, end].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(parser.finalize(0).state).toBe("completed");
  });

  it("does not complete on agent_end with willRetry until agent_settled", () => {
    const parser = new ProtocolParser();
    parser.feed([header, message, { type: "agent_end", willRetry: true, messages: [] }].map((value) => JSON.stringify(value)).join("\n") + "\n");
    // Incomplete while retry is pending and process has not settled.
    const mid = parser.finalize(null, undefined, "");
    // finalize assumes process closed; process still running isn't modelled here.
    // With willRetry pending and no settled, completeProtocol is false.
    expect(mid.protocol.agentEndSeen).toBe(true);
    expect(mid.protocol.agentSettledSeen).toBe(false);
    // hasUsefulOutput true → partial rather than failed.
    expect(mid.state).toBe("partial");

    const full = new ProtocolParser();
    full.feed([header, message, { type: "agent_end", willRetry: true }, end, settled].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(full.finalize(0).state).toBe("completed");
  });

  it("preserves partial paid work when stream is truncated after assistant output", () => {
    const parser = new ProtocolParser();
    parser.feed([header, message].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const result = parser.finalize(1);
    expect(result.state).toBe("partial");
    expect(result.liveText).toBe("hello world");
    expect(result.errorMessage).toMatch(/partial|exited/i);
  });

  it("classifies unexpected signals as failure (or partial when useful output exists)", () => {
    const empty = new ProtocolParser();
    empty.feed([header].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(empty.finalize(null, "SIGTERM")).toMatchObject({ state: "failed", stopReason: "unexpected_signal" });

    const partial = new ProtocolParser();
    partial.feed([header, message, end, settled].map((value) => JSON.stringify(value)).join("\n") + "\n");
    // Signal looses "successfulExit" even if protocol is complete → hasUsefulOutput → partial.
    expect(partial.finalize(null, "SIGTERM").state).toBe("partial");
  });

  it("captures full provider cost categories and malformed count", () => {
    const parser = new ProtocolParser();
    parser.feed(`bad json\n${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(end)}\n${JSON.stringify(settled)}\n`);
    const result = parser.finalize(0);
    expect(result.protocol.parseErrors).toBe(1);
    expect(result.usage).toMatchObject({ cost: .033, costInput: .01, costOutput: .02, reasoning: 3, turns: 1 });
  });

  it("folds nested toolResult usage into cumulative run usage", () => {
    const toolResult = {
      type: "message_end",
      message: {
        role: "toolResult", toolCallId: "c1", toolName: "subagent",
        content: [{ type: "text", text: "grandchild done" }], isError: false, timestamp: 2,
        usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, totalTokens: 155, cost: { input: .002, output: .001, cacheRead: 0, cacheWrite: 0, total: .003 } },
      },
    };
    const parser = new ProtocolParser();
    parser.feed([header, message, toolResult, end, settled].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const result = parser.finalize(0);
    expect(result.state).toBe("completed");
    // assistant (10/5/2/1, $0.033, 1 turn) + nested toolResult (100/40/10/5, $0.003, 0 turns)
    expect(result.usage).toMatchObject({ input: 110, output: 45, cacheRead: 12, cacheWrite: 6, turns: 1 });
    expect(result.usage.cost).toBeCloseTo(0.036);
    // context tokens still track the assistant turn, not the nested tool total.
    expect(result.usage.contextTokens).toBe(15);
  });

  it("ignores toolResult messages without usage (pre-#6671 children)", () => {
    const bare = {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
    };
    const parser = new ProtocolParser();
    parser.feed([header, message, bare, end, settled].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const result = parser.finalize(0);
    expect(result.usage).toMatchObject({ input: 10, output: 5, cost: 0.033, turns: 1 });
  });

  it("rejects oversized single lines without killing the parser", () => {
    const parser = new ProtocolParser();
    const huge = "x".repeat(5 * 1024 * 1024);
    parser.feed(huge + "\n" + JSON.stringify(header) + "\n" + JSON.stringify(message) + "\n" + JSON.stringify(end) + "\n" + JSON.stringify(settled) + "\n");
    const result = parser.finalize(0);
    expect(result.protocol.parseErrors).toBeGreaterThan(0);
    expect(result.state).toBe("completed");
  });
});
