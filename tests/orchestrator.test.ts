import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runTasks } from "../src/orchestrator.js";
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
});
