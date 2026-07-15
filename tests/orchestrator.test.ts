import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isTransientFailure, runTasks } from "../src/orchestrator.js";
import type { TaskResult } from "../src/types.js";
import type { TaskSpec } from "../src/types.js";
// @ts-expect-error plain ESM child fixture
import { getFakePiCommand } from "./helpers/fake-pi.mjs";

const spec = (extra: Partial<TaskSpec> = {}): TaskSpec => ({ task: "test", profile: "explore", tools: ["read"], timeoutMs: 2000, ...extra });

describe("orchestrator", () => {
  let dir: string;
  let previousMode: string | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-"));
    previousMode = process.env.FAKE_PI_MODE;
    process.env.FAKE_PI_MODE = "success";
  });
  afterEach(async () => {
    if (previousMode === undefined) delete process.env.FAKE_PI_MODE; else process.env.FAKE_PI_MODE = previousMode;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the full artifact and marks file-only without erasing accounting", async () => {
    const output = path.join(dir, "report.md");
    const result = await runTasks([spec({ output, outputMode: "file-only" })], {
      getPiCommand: () => getFakePiCommand(), sessionDir: path.join(dir, "sessions"),
    });
    expect(await fs.readFile(output, "utf8")).toBe("Hello world!");
    expect(result.results[0]).toMatchObject({ outputFile: output, outputMode: "file-only" });
    expect(result.results[0]!.usage.cost).toBe(0.001);
  });

  it("reports cancellation during setup as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runTasks([spec({ isolation: "worktree" })], {
      getPiCommand: () => getFakePiCommand(), sessionDir: path.join(dir, "sessions"), signal: controller.signal,
    });
    expect(result.state).toBe("cancelled");
    expect(result.results[0]).toMatchObject({ state: "cancelled", stopReason: "cancelled" });
  });

  it("uses a shared semaphore for parallel tasks and preserves all costs", async () => {
    const result = await runTasks([spec(), spec(), spec()], {
      getPiCommand: () => getFakePiCommand(), sessionDir: path.join(dir, "sessions"),
    });
    expect(result.state).toBe("completed");
    expect(result.results).toHaveLength(3);
    expect(result.results.reduce((sum, item) => sum + item.usage.cost, 0)).toBeCloseTo(0.003);
  });

  it("classifies transient vs non-transient failures", () => {
    const base: TaskResult = {
      label: "t", task: "x", state: "failed", exitCode: 1, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      protocol: { headerSeen: true, assistantEndSeen: true, agentEndSeen: true, agentSettledSeen: true, validEvents: 1, parseErrors: 0 },
    };
    // Transient: infrastructure problems.
    expect(isTransientFailure({ ...base, state: "timeout", timeoutPhase: "queued", stopReason: "timeout" })).toBe(true);
    expect(isTransientFailure({ ...base, state: "partial", stopReason: "stalled" })).toBe(true);
    expect(isTransientFailure({ ...base, stopReason: "spawn_error" })).toBe(true);
    expect(isTransientFailure({ ...base, stopReason: "error" })).toBe(true);
    expect(isTransientFailure({ ...base, stopReason: "protocol_error" })).toBe(true);
    // Non-transient: task/user outcomes.
    expect(isTransientFailure({ ...base, state: "cancelled", stopReason: "cancelled" })).toBe(false);
    expect(isTransientFailure({ ...base, state: "partial", stopReason: "max_turns" })).toBe(false);
    expect(isTransientFailure({ ...base, state: "timeout", timeoutPhase: "running", stopReason: "timeout" })).toBe(false);
    expect(isTransientFailure({ ...base, state: "completed", stopReason: "stop" })).toBe(false);
    expect(isTransientFailure({ ...base, stopReason: "nonzero_exit" })).toBe(false);
  });

  it("retries a transient provider failure on the fallback model and records attempts", async () => {
    process.env.FAKE_PI_MODE = "flaky-then-success";
    const marker = path.join(dir, "flaky-marker");
    process.env.FAKE_PI_FLAKY_MARKER = marker;
    const result = await runTasks(
      [spec({ model: "primary/model", fallbackModels: ["backup/model"], maxRetries: 1 })],
      { getPiCommand: () => getFakePiCommand(), sessionDir: path.join(dir, "sessions") },
    );
    delete process.env.FAKE_PI_FLAKY_MARKER;
    expect(result.results[0]!.state).toBe("completed");
    expect(result.results[0]!.attempts).toBe(2);
    expect(result.results[0]!.attemptedModels).toEqual(["primary/model", "backup/model"]);
    // Usage accumulates across both attempts (each billed 0.001).
    expect(result.results[0]!.usage.cost).toBeCloseTo(0.002);
  });

  it("does not retry non-transient failures", async () => {
    process.env.FAKE_PI_MODE = "nonzero-complete";
    const result = await runTasks(
      [spec({ model: "primary/model", fallbackModels: ["backup/model"], maxRetries: 2 })],
      { getPiCommand: () => getFakePiCommand(), sessionDir: path.join(dir, "sessions") },
    );
    expect(result.results[0]!.state).toBe("failed");
    expect(result.results[0]!.attempts).toBeUndefined();
  });

  it("exhausted retries surface the attempt history in the error", async () => {
    process.env.FAKE_PI_MODE = "provider-error";
    const result = await runTasks(
      [spec({ model: "a/one", fallbackModels: ["b/two"], maxRetries: 1 })],
      { getPiCommand: () => getFakePiCommand(), sessionDir: path.join(dir, "sessions") },
    );
    expect(result.results[0]!.state).toBe("failed");
    expect(result.results[0]!.attempts).toBe(2);
    expect(result.results[0]!.errorMessage).toContain("a/one → b/two");
  });
});
