import { describe, expect, it } from "vitest";
import { addUsage, buildUsageLedger, hasBilledUsage, rootUsageFromEntries, subagentUsageFromEntries, toPiUsage, usageFromMessage, usageFromToolResultMessage } from "../src/usage.js";
import { RUN_ENTRY_TYPE } from "../src/persistence.js";

const usage = (cost: number, input = 10, output = 5) => ({
  input, output, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: input + output,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

const assistant = (cost: number) => ({ role: "assistant", content: [], model: "m", provider: "p", api: "x", stopReason: "stop", timestamp: 1, usage: usage(cost) });

function terminal(id: string, cost: number, sequence = 1) {
  return {
    type: "custom", customType: RUN_ENTRY_TYPE,
    data: { schemaVersion: 1, id, sessionKey: "s", timestamp: sequence, sequence, type: "terminal", data: {
      state: "completed", results: [{ label: "t", task: "x", state: "completed", exitCode: 0, usage: usageFromMessage(assistant(cost) as any) }],
    } },
  };
}

describe("usage ledger", () => {
  it("uses provider reported total and category costs", () => {
    const result = usageFromMessage(assistant(0.42) as any);
    expect(result.cost).toBe(0.42);
    expect(result.costInput).toBe(0.21);
    expect(result.costOutput).toBe(0.21);
    expect(result.reasoning).toBe(3);
    expect(result.turns).toBe(1);
  });

  it("falls back to provider categories and rejects malformed negative usage", () => {
    const message: any = assistant(0.4);
    delete message.usage.cost.total;
    message.usage.input = -100;
    message.usage.reasoning = Number.NaN;
    const result = usageFromMessage(message);
    expect(result.cost).toBeCloseTo(0.4);
    expect(result.input).toBe(0);
    expect(result.reasoning).toBe(0);
  });

  it("extracts nested toolResult usage without counting a turn or context", () => {
    const message = {
      role: "toolResult", toolCallId: "c1", toolName: "subagent",
      content: [{ type: "text", text: "done" }], isError: false, timestamp: 1,
      usage: usage(0.3, 100, 40),
    };
    const result = usageFromToolResultMessage(message);
    expect(result).toMatchObject({ input: 100, output: 40, cost: 0.3, turns: 0, contextTokens: 0 });
    // Wrong role or missing usage contributes nothing.
    expect(usageFromToolResultMessage(assistant(0.5))).toMatchObject({ cost: 0, turns: 0 });
    expect(usageFromToolResultMessage({ role: "toolResult" })).toMatchObject({ cost: 0 });
  });

  it("converts aggregate stats to Pi's native Usage shape", () => {
    const stats = addUsage(
      usageFromMessage(assistant(0.42) as any),
      usageFromMessage(assistant(0.08) as any),
    );
    const pi = toPiUsage(stats);
    expect(pi).toEqual({
      input: 20, output: 10, cacheRead: 4, cacheWrite: 2,
      reasoning: 6, totalTokens: 36,
      cost: { input: 0.25, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    });
    // Category costs reconcile with the reported total for well-formed input.
    expect(pi.cost.input + pi.cost.output + pi.cost.cacheRead + pi.cost.cacheWrite).toBeCloseTo(pi.cost.total);
  });

  it("omits reasoning from converted usage when zero and reports billed-ness", () => {
    const zero = toPiUsage(addUsage());
    expect("reasoning" in zero).toBe(false);
    expect(zero.totalTokens).toBe(0);
    expect(hasBilledUsage(addUsage())).toBe(false);
    expect(hasBilledUsage(undefined)).toBe(false);
    expect(hasBilledUsage(usageFromMessage(assistant(0.01) as any))).toBe(true);
    // Tokens without cost still count as billed work (zero-cost providers).
    expect(hasBilledUsage({ input: 5 })).toBe(true);
  });

  it("totals root active-branch messages once by entry id", () => {
    const entries = [
      { type: "message", id: "m1", message: assistant(0.1) },
      { type: "message", id: "m1", message: assistant(0.1) },
      { type: "message", id: "m2", message: assistant(0.2) },
      terminal("child", 0.9),
    ];
    const root = rootUsageFromEntries(entries);
    expect(root.cost).toBeCloseTo(0.3);
    expect(root.turns).toBe(2);
  });

  it("retains checkpointed billed usage when a run crashes before terminal", () => {
    const checkpoint = terminal("crashed", 0.4);
    checkpoint.data.type = "checkpoint";
    checkpoint.data.data.state = "running";
    const sub = subagentUsageFromEntries([checkpoint]);
    expect(sub.usage.cost).toBeCloseTo(0.4);
    expect(sub.runCount).toBe(1);
  });

  it("counts each terminal subagent run once across delivery/replay", () => {
    const entries = [
      terminal("r1", 0.4, 1),
      { type: "custom", customType: RUN_ENTRY_TYPE, data: { schemaVersion: 1, id: "r1", sessionKey: "s", timestamp: 2, sequence: 2, type: "delivered", data: { delivered: true } } },
      terminal("r1", 0.4, 3), // latest terminal replaces, never adds twice
      terminal("r2", 0.6, 4),
    ];
    const sub = subagentUsageFromEntries(entries);
    expect(sub.usage.cost).toBeCloseTo(1.0);
    expect(sub.runCount).toBe(2);
    expect(sub.taskCount).toBe(2);
  });

  it("reports root, subagent, combined without double counting snapshots", () => {
    const entries = [{ type: "message", id: "m1", message: assistant(0.25) }, terminal("r1", 0.5)];
    const snapshot: any = { id: "r1", state: "completed", results: [{ usage: usageFromMessage(assistant(0.5) as any) }] };
    const ledger = buildUsageLedger(entries, [snapshot]);
    expect(ledger.root.cost).toBeCloseTo(0.25);
    expect(ledger.subagents.cost).toBeCloseTo(0.5);
    expect(ledger.combined.cost).toBeCloseTo(0.75);
    expect(ledger.runCount).toBe(1);
  });

  it("supplements message_end usage only until matching branch multiplicity catches up", () => {
    const first = assistant(0.1) as any;
    const second = assistant(0.1) as any; // intentionally identical provider metadata
    expect(buildUsageLedger([], [], [first, second]).root.cost).toBeCloseTo(0.2);
    expect(buildUsageLedger([{ type: "message", id: "m1", message: first }], [], [first, second]).root.cost).toBeCloseTo(0.2);
    expect(buildUsageLedger([
      { type: "message", id: "m1", message: first },
      { type: "message", id: "m2", message: second },
    ], [], [first, second]).root.cost).toBeCloseTo(0.2);
  });

  it("includes billed usage from active runs before terminal persistence", () => {
    const running: any = {
      id: "live", state: "running",
      results: [{ usage: usageFromMessage(assistant(0.35) as any) }],
    };
    const ledger = buildUsageLedger([], [running]);
    expect(ledger.subagents.cost).toBeCloseTo(0.35);
    expect(ledger.combined.cost).toBeCloseTo(0.35);
    expect(ledger.runCount).toBe(1);
  });

  it("uses newer live cumulative usage instead of a stale persisted checkpoint", () => {
    const checkpoint = terminal("live", 0.1);
    checkpoint.data.type = "checkpoint";
    const running: any = {
      id: "live", state: "running",
      results: [{ usage: usageFromMessage(assistant(0.35) as any) }],
    };
    const ledger = buildUsageLedger([checkpoint], [running]);
    expect(ledger.subagents.cost).toBeCloseTo(0.35);
    expect(ledger.runCount).toBe(1);
  });

  it("sums parallel task usage and resumed runs as independent billed work", () => {
    const a = usageFromMessage(assistant(0.1) as any);
    const b = usageFromMessage(assistant(0.2) as any);
    const total = addUsage(a, b);
    expect(total.cost).toBeCloseTo(0.3);
    expect(total.turns).toBe(2);
    expect(total.contextTokens).toBe(b.contextTokens); // latest point-in-time context, not a sum
  });
});
