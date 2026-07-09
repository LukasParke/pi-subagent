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

  it("timeout terminates with timeout stopReason", async () => {
    process.env.FAKE_PI_MODE = "signal";
    const result = await runner.run({ ...defaultSpec, timeoutMs: 40 });
    expect(result.stopReason).toBe("timeout");
    expect(result.state).toBe("failed");
  });

  it("budget termination after usage captured (maxTurns)", async () => {
    process.env.FAKE_PI_MODE = "success";
    const result = await runner.run({ ...defaultSpec, maxTurns: 0 });
    expect(result.stopReason).toBe("max_turns");
    expect(result.usage.turns).toBeGreaterThan(0);
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
});
