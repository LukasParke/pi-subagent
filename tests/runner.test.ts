import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChildRunner } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
import * as fs from "node:fs/promises";
// @ts-expect-error test helper is plain ESM without types
import { getFakePiCommand } from "./helpers/fake-pi.mjs";
import type { TaskSpec } from "../src/types.js";

describe("ChildRunner", () => {
  let semaphore: Semaphore;
  let runner: ChildRunner;
  let onCheckpoint: (result: Partial<import("../src/types.js").TaskResult>) => void;
  let checkpointCalls: unknown[];
  let previousMode: string | undefined;
  let previousDelay: string | undefined;

  beforeEach(() => {
    previousMode = process.env.FAKE_PI_MODE;
    previousDelay = process.env.FAKE_PI_DELAY_MS;
    semaphore = new Semaphore(2, 10);
    checkpointCalls = [];
    onCheckpoint = (partial) => {
      checkpointCalls.push(partial);
    };
    const fake = getFakePiCommand();
    runner = new ChildRunner(
      semaphore,
      () => fake,
      "/tmp/test-sessions-pi-subagent",
      onCheckpoint,
      50,
    );
  });

  afterEach(() => {
    if (previousMode === undefined) delete process.env.FAKE_PI_MODE;
    else process.env.FAKE_PI_MODE = previousMode;
    if (previousDelay === undefined) delete process.env.FAKE_PI_DELAY_MS;
    else process.env.FAKE_PI_DELAY_MS = previousDelay;
  });

  const defaultSpec: TaskSpec = {
    task: "Test the runner",
    timeoutMs: 10_000,
    profile: "general",
  };

  it("success/streaming: parses header and concatenates text parts", async () => {
    process.env.FAKE_PI_MODE = "success";
    const result = await runner.run(defaultSpec);
    expect(result.state).toBe("completed");
    expect(result.protocol.headerSeen).toBe(true);
    expect(result.protocol.assistantEndSeen).toBe(true);
    expect(result.liveText).toContain("Hello");
    expect(result.liveText).toContain("world!");
    expect(result.usage.turns).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("test-session-123");
    expect(checkpointCalls.length).toBeGreaterThan(0);
  });

  it("malformed lines are counted and run still succeeds with core events", async () => {
    process.env.FAKE_PI_MODE = "malformed";
    const result = await runner.run(defaultSpec);
    expect(result.protocol.parseErrors).toBeGreaterThan(0);
    expect(result.protocol.headerSeen).toBe(true);
    expect(result.state).toBe("completed");
  });

  it("exit 0 with incomplete protocol is failure", async () => {
    process.env.FAKE_PI_MODE = "incomplete";
    const result = await runner.run(defaultSpec);
    expect(result.state).toBe("failed");
    expect(result.stopReason).toBe("protocol_error");
    expect(result.exitCode).not.toBe(0);
  });

  it("cancellation before spawn never starts work", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runner.run(defaultSpec, ac.signal);
    expect(result.state).toBe("cancelled");
  });

  it("cancellation during run marks cancelled", async () => {
    process.env.FAKE_PI_MODE = "signal";
    const ac = new AbortController();
    const p = runner.run(defaultSpec, ac.signal);
    setTimeout(() => ac.abort(), 30);
    const result = await p;
    expect(result.state).toBe("cancelled");
  });

  it("timeout during run marks timeout with phase=running", async () => {
    process.env.FAKE_PI_MODE = "signal";
    const result = await runner.run({ ...defaultSpec, timeoutMs: 40 });
    expect(result.stopReason).toBe("timeout");
    expect(result.state).toBe("timeout");
    expect(result.timeoutPhase).toBe("running");
  });

  it("budget termination preserves partial work (maxTurns, graceTurns=0)", async () => {
    process.env.FAKE_PI_MODE = "success";
    const result = await runner.run({ ...defaultSpec, maxTurns: 0, graceTurns: 0 });
    expect(result.stopReason).toBe("max_turns");
    expect(result.usage.turns).toBeGreaterThan(0);
    // Budget stops are expected outcomes: completed turns are partial success, not failure.
    expect(result.state).toBe("partial");
    expect(result.errorMessage).toMatch(/budget/i);
  });

  it("budget breach steers a wrap-up and marks wrappedUp when the child concludes in grace", async () => {
    process.env.FAKE_PI_MODE = "wrap-up";
    const result = await runner.run({ ...defaultSpec, maxTurns: 2, graceTurns: 3, timeoutMs: 8_000 });
    expect(result.state).toBe("partial");
    expect(result.stopReason).toBe("max_turns");
    expect(result.wrappedUp).toBe(true);
    expect(result.liveText).toContain("FINAL WRAP-UP");
    expect(result.errorMessage).toMatch(/wrapped up gracefully/i);
  });

  it("budget breach hard-stops after grace turns when the child keeps working", async () => {
    // steer-echo never sees the wrap-up because it only echoes; use success mode
    // with maxTurns 0 and grace 0 covered above. Here: wrap-up child that ignores
    // the steer is emulated by a tiny grace window on the multi-turn script.
    process.env.FAKE_PI_MODE = "wrap-up";
    process.env.FAKE_PI_IGNORE_STEER = "1";
    const result = await runner.run({ ...defaultSpec, maxTurns: 1, graceTurns: 1, timeoutMs: 8_000 });
    expect(result.state).toBe("partial");
    expect(result.stopReason).toBe("max_turns");
    expect(result.wrappedUp).toBeUndefined();
    delete process.env.FAKE_PI_IGNORE_STEER;
  });

  it("stall watchdog flags then kills a silent child; completed turns stay partial", async () => {
    process.env.FAKE_PI_MODE = "stall";
    const stallRunner = new ChildRunner(
      semaphore,
      () => getFakePiCommand(),
      "/tmp/test-sessions-pi-subagent",
      onCheckpoint,
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      { stallAfterMs: 300, stallKillAfterMs: 300 },
    );
    const result = await stallRunner.run({ ...defaultSpec, timeoutMs: 30_000 });
    expect(result.stopReason).toBe("stalled");
    expect(result.state).toBe("partial"); // one message arrived before silence
    expect(result.errorMessage).toMatch(/no protocol activity/i);
    // The stall flag surfaced through checkpoints before the kill.
    expect(checkpointCalls.some((c: any) => c.stalledSince !== undefined)).toBe(true);
  });

  it("stall watchdog stays quiet for an active child", async () => {
    process.env.FAKE_PI_MODE = "pause-after-message";
    process.env.FAKE_PI_PAUSE_MS = "300";
    const activeRunner = new ChildRunner(
      semaphore,
      () => getFakePiCommand(),
      "/tmp/test-sessions-pi-subagent",
      onCheckpoint,
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      // Stall window longer than the pause: must never trigger.
      { stallAfterMs: 5_000, stallKillAfterMs: 1_000 },
    );
    const result = await activeRunner.run({ ...defaultSpec, timeoutMs: 10_000 });
    expect(result.state).toBe("completed");
    expect(result.stopReason).not.toBe("stalled");
    delete process.env.FAKE_PI_PAUSE_MS;
  });

  it("timeout budget includes semaphore queue time and reports phase=queued", async () => {
    process.env.FAKE_PI_MODE = "signal";
    const tight = new Semaphore(1, 10);
    const fake = getFakePiCommand();
    const makeRunner = () => new ChildRunner(tight, () => fake, "/tmp/test-sessions-pi-subagent", undefined, 50);
    const hog = makeRunner().run({ ...defaultSpec, timeoutMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Second task queues behind the hog and must time out while still queued.
    const queued = await makeRunner().run({ ...defaultSpec, timeoutMs: 60 });
    expect(queued.stopReason).toBe("timeout");
    expect(queued.state).toBe("timeout");
    expect(queued.timeoutPhase).toBe("queued");
    expect(queued.errorMessage).toMatch(/never started/i);
    await hog;
  });

  it("preserves partial output when child crashes after assistant turn", async () => {
    process.env.FAKE_PI_MODE = "partial-crash";
    const result = await runner.run(defaultSpec);
    expect(result.state).toBe("partial");
    expect(result.liveText).toMatch(/Hello/);
  });

  it("completes on agent_settled after a willRetry agent_end", async () => {
    process.env.FAKE_PI_MODE = "retry";
    const result = await runner.run(defaultSpec);
    expect(result.state).toBe("completed");
    expect(result.protocol.agentSettledSeen).toBe(true);
  });

  it("completes on legacy agent_end without agent_settled", async () => {
    process.env.FAKE_PI_MODE = "legacy-no-settled";
    const result = await runner.run(defaultSpec);
    expect(result.state).toBe("completed");
  });

  it("builds an incremental transcript during the run", async () => {
    process.env.FAKE_PI_MODE = "success";
    const result = await runner.run(defaultSpec);
    expect(result.transcript).toContain("Hello");
    expect(result.transcript).toContain("world!");
  });

  it("performs temp prompt cleanup", async () => {
    process.env.FAKE_PI_MODE = "success";
    const before = await fs.readdir("/tmp").then((names) =>
      names.filter((n) => n.startsWith("pi-subagent-prompt-")),
    );
    await runner.run({ ...defaultSpec, systemPrompt: "Custom system prompt" });
    const after = await fs.readdir("/tmp").then((names) =>
      names.filter((n) => n.startsWith("pi-subagent-prompt-")),
    );
    // Temp prompt dirs created during the run should be removed afterward.
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });

  it("captures stderr on child failure", async () => {
    process.env.FAKE_PI_MODE = "error";
    const result = await runner.run(defaultSpec);
    expect(result.stderr).toMatch(/stderr/i);
    expect(result.state).toBe("failed");
  });

  it("fails a complete protocol that exits nonzero", async () => {
    process.env.FAKE_PI_MODE = "nonzero-complete";
    const result = await runner.run(defaultSpec);
    expect(result).toMatchObject({ state: "failed", stopReason: "nonzero_exit", exitCode: 1 });
  });

  it("fails provider error stop reasons even with exit zero", async () => {
    process.env.FAKE_PI_MODE = "provider-error";
    const result = await runner.run(defaultSpec);
    expect(result).toMatchObject({ state: "failed", stopReason: "error", errorMessage: "provider failed" });
  });

  it("parses an unterminated final JSON line", async () => {
    process.env.FAKE_PI_MODE = "unterminated";
    const result = await runner.run(defaultSpec);
    expect(result.state).toBe("completed");
    expect(result.protocol.agentEndSeen).toBe(true);
  });

  it("steers a running child mid-run over the stdin command channel", async () => {
    process.env.FAKE_PI_MODE = "steer-echo";
    const promise = runner.run({ ...defaultSpec, timeoutMs: 5_000 });
    // Wait until the child is live (first message emitted), then steer.
    await vi.waitFor(() => {
      expect(runner.steer("focus on the tests")).toBe(true);
    }, { timeout: 3_000 });
    const result = await promise;
    expect(result.state).toBe("completed");
    expect(result.liveText).toContain("steered: focus on the tests");
  });

  it("steer returns false when no child is running", () => {
    expect(runner.steer("too late")).toBe(false);
  });

  it("fails fast when the child rejects the prompt", async () => {
    process.env.FAKE_PI_MODE = "prompt-rejected";
    const result = await runner.run({ ...defaultSpec, timeoutMs: 5_000 });
    expect(result.state).toBe("failed");
    expect(result.errorMessage).toMatch(/prompt rejected/i);
  });

  it("uses the spec label on results", async () => {
    process.env.FAKE_PI_MODE = "success";
    const result = await runner.run({ ...defaultSpec, label: "Audit auth" });
    expect(result.label).toBe("Audit auth");
  });
});
