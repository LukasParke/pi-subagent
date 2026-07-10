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

describe("ProtocolParser", () => {
  it("emits every update from a batched chunk", () => {
    const parser = new ProtocolParser();
    const updates = parser.feed([header, { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "hi" } }, message, end].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(updates.map((u) => u.type)).toEqual(["session", "live-text", "message", "agent-end"]);
  });

  it("flushes a final unterminated JSON line", () => {
    const parser = new ProtocolParser();
    parser.feed(JSON.stringify(header) + "\n" + JSON.stringify(message) + "\n" + JSON.stringify(end));
    const result = parser.finalize(0);
    expect(result.state).toBe("completed");
    expect(result.protocol.agentEndSeen).toBe(true);
    expect(result.liveText).toBe("hello world");
  });

  it("requires header, assistant message, agent_end and exit zero", () => {
    const variants = [
      [message, end],
      [header, end],
      [header, message],
    ];
    for (const events of variants) {
      const parser = new ProtocolParser();
      parser.feed(events.map((value) => JSON.stringify(value)).join("\n") + "\n");
      expect(parser.finalize(0).state).toBe("failed");
    }
    const nonzero = new ProtocolParser();
    nonzero.feed([header, message, end].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(nonzero.finalize(1)).toMatchObject({ state: "failed", stopReason: "nonzero_exit" });
  });

  it("classifies unexpected signals as failure", () => {
    const parser = new ProtocolParser();
    parser.feed([header, message, end].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(parser.finalize(null, "SIGTERM")).toMatchObject({ state: "failed", stopReason: "unexpected_signal" });
  });

  it("captures full provider cost categories and malformed count", () => {
    const parser = new ProtocolParser();
    parser.feed(`bad json\n${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(end)}\n`);
    const result = parser.finalize(0);
    expect(result.protocol.parseErrors).toBe(1);
    expect(result.usage).toMatchObject({ cost: .033, costInput: .01, costOutput: .02, reasoning: 3, turns: 1 });
  });
});
