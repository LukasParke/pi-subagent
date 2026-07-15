import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import register from "../src/extension.js";
import { RUN_ENTRY_TYPE } from "../src/persistence.js";

interface Harness {
  tool: any;
  handlers: Map<string, Function>;
  entries: any[];
  ctx: any;
  pi: any;
  sentMessages: Array<{ message: any; options?: any }>;
}

function rootAssistant(cost: number) {
  return {
    type: "message", id: `root-${cost}`, parentId: null, timestamp: new Date().toISOString(),
    message: {
      role: "assistant", content: [], provider: "p", api: "x", model: "m", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } },
    },
  };
}

function harness(): Harness {
  const handlers = new Map<string, Function>();
  const entries: any[] = [rootAssistant(0.2)];
  let tool: any;
  const ui = {
    theme: { fg: (_c: string, text: string) => text, bold: (text: string) => text },
    setStatus: vi.fn(), notify: vi.fn(), setEditorText: vi.fn(),
    setWidget: vi.fn(), custom: vi.fn(),
  };
  const ctx = {
    cwd: process.cwd(), hasUI: false, ui, model: { provider: "fake", id: "model" },
    sessionManager: {
      getSessionFile: () => "/tmp/root-session.jsonl",
      getSessionId: () => "root-session",
      getBranch: () => entries,
    },
  };
  const sentMessages: any[] = [];
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (definition: any) => { tool = definition; },
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: (message: any, options?: any) => { sentMessages.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => entries.push({
      type: "custom", customType, data, id: `e-${entries.length}`, parentId: null, timestamp: new Date().toISOString(),
    }),
    getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name })),
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "off",
  };
  register(pi as any);
  return { get tool() { return tool; }, handlers, entries, ctx, pi, sentMessages } as unknown as Harness;
}

async function execute(h: Harness, params: any, signal?: AbortSignal, update = vi.fn()) {
  return h.tool.execute("call", params, signal, update, h.ctx);
}

function runId(text: string): string {
  const match = text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
  if (!match) throw new Error(`No run id in: ${text}`);
  return match[0];
}

describe("extension end-to-end wiring", () => {
  let bin: string;
  let originalPath: string | undefined;
  let originalMode: string | undefined;
  let originalDelay: string | undefined;

  let originalBin: string | undefined;

  beforeEach(async () => {
    originalPath = process.env.PATH;
    originalMode = process.env.FAKE_PI_MODE;
    originalDelay = process.env.FAKE_PI_DELAY_MS;
    originalBin = process.env.PI_SUBAGENT_BIN;
    bin = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-bin-"));
    const fake = path.resolve("tests/helpers/fake-pi.mjs");
    const script = `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`;
    const piPath = path.join(bin, "pi");
    await fs.writeFile(piPath, script, { mode: 0o755 });
    // Prefer the explicit bin resolver (locks in the fake even when argv[1] points at vitest).
    process.env.PI_SUBAGENT_BIN = piPath;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.FAKE_PI_MODE = "success";
    delete process.env.FAKE_PI_DELAY_MS;
    // Force re-resolution under the new env for any cached launch state.
    const { _resetLaunchCacheForTests } = await import("../src/launch.js");
    _resetLaunchCacheForTests();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalMode === undefined) delete process.env.FAKE_PI_MODE; else process.env.FAKE_PI_MODE = originalMode;
    if (originalDelay === undefined) delete process.env.FAKE_PI_DELAY_MS; else process.env.FAKE_PI_DELAY_MS = originalDelay;
    if (originalBin === undefined) delete process.env.PI_SUBAGENT_BIN; else process.env.PI_SUBAGENT_BIN = originalBin;
    const { _resetLaunchCacheForTests } = await import("../src/launch.js");
    _resetLaunchCacheForTests();
    await fs.rm(bin, { recursive: true, force: true });
  });

  it("runs foreground, persists usage, and reports root/subagent/combined cost", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    const result = await execute(h, { task: "hello", profile: "explore" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe("Hello world!");
    const terminal = h.entries.find((entry) => entry.customType === RUN_ENTRY_TYPE && entry.data.type === "terminal");
    expect(terminal.data.data.results[0].usage.cost).toBe(0.001);
    const status = await execute(h, { action: "status" });
    expect(status.content[0].text).toContain("root $0.2000");
    expect(status.content[0].text).toContain("subagents $0.0010");
    expect(status.content[0].text).toContain("combined $0.2010");
    await h.handlers.get("session_shutdown")!();
  });

  it("includes provider usage in combined totals while a run is still active", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_MODE = "pause-after-message";
    const started = await execute(h, { task: "live cost", profile: "explore", async: true });
    const id = runId(started.content[0].text);
    await vi.waitFor(() => {
      const run = h.entries.find((entry) => entry.customType === RUN_ENTRY_TYPE && entry.data.id === id && entry.data.type === "checkpoint" && entry.data.data.results?.[0]?.usage?.cost > 0);
      expect(run).toBeTruthy();
    });
    const status = await execute(h, { action: "status", id });
    expect(status.content[0].text).toContain("subagents $0.0010");
    expect(status.content[0].text).toContain("combined $0.2010");
    await execute(h, { action: "wait", id });
    await h.handlers.get("session_shutdown")!();
  });

  it("supports async wait exactly once and streams partial updates", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_DELAY_MS = "80";
    const update = vi.fn();
    const started = await execute(h, { task: "async", profile: "explore", async: true }, undefined, update);
    const id = runId(started.content[0].text);
    const live = await execute(h, { action: "status", id });
    expect(live.content[0].text).toContain(id.slice(0, 8));
    const waited = await execute(h, { action: "wait", id });
    expect(waited.content[0].text).toBe("Hello world!");
    expect(update).toHaveBeenCalled();
    const duplicate = await execute(h, { action: "wait", id });
    expect(duplicate.content[0].text).toContain("already delivered");
    await h.handlers.get("session_shutdown")!();
  });

  it("wait is interruptible without cancelling the background run", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_DELAY_MS = "200";
    const started = await execute(h, { task: "slow", profile: "explore", async: true });
    const id = runId(started.content[0].text);

    const abort = new AbortController();
    const waiting = execute(h, { action: "wait", id }, abort.signal);
    setTimeout(() => abort.abort(), 20);
    const interrupted = await waiting;
    expect(interrupted.content[0].text).toContain("Wait aborted");
    expect(interrupted.content[0].text).toContain("continues in the background");

    // The run was NOT cancelled or delivered: a later wait still delivers once.
    const delivered = await execute(h, { action: "wait", id });
    expect(delivered.content[0].text).toBe("Hello world!");
    await h.handlers.get("session_shutdown")!();
  });

  it("rejects concurrent direct resume and permits fork", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_DELAY_MS = "150";
    const first = await execute(h, { task: "continue", resume: "child-existing", profile: "explore", async: true });
    const firstId = runId(first.content[0].text);
    await expect(execute(h, { task: "also continue", resume: "child-existing", profile: "explore", async: true }))
      .rejects.toThrow(firstId);
    const fork = await execute(h, { task: "fork", resume: "child-existing", fork_resume: true, profile: "explore" });
    expect(fork.isError).not.toBe(true);
    await execute(h, { action: "wait", id: firstId });
    await h.handlers.get("session_shutdown")!();
  });

  it("throws failures so Pi marks tool results as errors", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    await expect(execute(h, { action: "status", id: "missing" })).rejects.toThrow("not found");
    process.env.FAKE_PI_MODE = "error";
    await expect(execute(h, { task: "fail", profile: "explore" })).rejects.toThrow();
    await h.handlers.get("session_shutdown")!();
  });

  it("renderers return real Component objects", async () => {
    const h = harness();
    const theme = h.ctx.ui.theme;
    const call = h.tool.renderCall({ task: "x" }, theme, { expanded: false });
    expect(typeof call.render).toBe("function");
    expect(call.render(80)).toEqual(expect.any(Array));
    const rendered = h.tool.renderResult(
      { content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } },
      { expanded: false, isPartial: false }, theme, {},
    );
    expect(typeof rendered.render).toBe("function");
    expect(rendered.render(80)).toEqual(expect.any(Array));
  });

  it("shutdown cancels and awaits live work without cross-session append", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_MODE = "signal";
    const started = await execute(h, { task: "sleep", profile: "explore", async: true });
    const id = runId(started.content[0].text);
    await h.handlers.get("session_shutdown")!();
    const terminal = h.entries.find((entry) => entry.customType === RUN_ENTRY_TYPE && entry.data.id === id && entry.data.type === "terminal");
    expect(terminal).toBeTruthy();
    expect(["cancelled", "failed"]).toContain(terminal.data.data.state);
  });

  it("steers a running background child mid-run", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_MODE = "steer-echo";
    process.env.FAKE_PI_PAUSE_MS = "3000";
    const started = await execute(h, { task: "steerable work", profile: "explore", async: true });
    const id = runId(started.content[0].text);
    // Wait until the child has produced its first message (steerable window).
    await vi.waitFor(async () => {
      const steered = await execute(h, { action: "steer", id, message: "pivot to plan B" });
      expect(steered.content[0].text).toMatch(/Steering message queued/i);
    }, { timeout: 4_000, interval: 100 });
    const waited = await execute(h, { action: "wait", id });
    expect(waited.content[0].text).toContain("steered: pivot to plan B");
    delete process.env.FAKE_PI_PAUSE_MS;
    await h.handlers.get("session_shutdown")!();
  });

  it("steer on a finished run fails with guidance", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    const done = await execute(h, { task: "quick", profile: "explore", async: true });
    const id = runId(done.content[0].text);
    await execute(h, { action: "wait", id });
    await expect(execute(h, { action: "steer", id, message: "too late" })).rejects.toThrow(/not running/i);
    await h.handlers.get("session_shutdown")!();
  });

  it("labels tasks from description and applies per-profile config defaults", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    const result = await execute(h, { task: "hello", description: "Greet the world", profile: "explore" });
    expect(result.isError).not.toBe(true);
    expect(result.details.results[0].label).toBe("Greet the world");
    await h.handlers.get("session_shutdown")!();
  });

  it("synthesis adds a fan-in result ahead of parallel outputs", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    const result = await execute(h, {
      tasks: [
        { task: "scan a", description: "Scan A" },
        { task: "scan b", description: "Scan B" },
      ],
      synthesis: "Merge both scans into one brief",
    });
    expect(result.isError).not.toBe(true);
    const labels = result.details.results.map((r: any) => r.label);
    expect(labels[0]).toBe("synthesis");
    expect(labels).toContain("Scan A");
    expect(labels).toContain("Scan B");
    // Synthesis child received the fan-in prompt sections (fake echoes fixed text,
    // so just assert the synthesis result completed and is first in delivery).
    expect(result.details.results[0].state).toBe("completed");
    await h.handlers.get("session_shutdown")!();
  });

  it("context:'fork' spawns the child with --fork <parent session file>", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    // The parent session file must exist for the fork preflight.
    await fs.writeFile("/tmp/root-session.jsonl", "{}\n");
    const result = await execute(h, { task: "continue our discussion", context: "fork", profile: "explore" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe("Hello world!");
    await h.handlers.get("session_shutdown")!();
    await fs.rm("/tmp/root-session.jsonl", { force: true });
  });

  it("resolves named agent files end-to-end through the tool", async () => {
    // Agent files live in the harness cwd (process.cwd()) — use a temp project dir.
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agentproj-"));
    await fs.mkdir(path.join(project, ".pi", "agents"), { recursive: true });
    await fs.writeFile(
      path.join(project, ".pi", "agents", "scout.md"),
      "---\ndescription: Fast recon\nprofile: explore\nmax_turns: 7\n---\nYou are a scout. Be terse.\n",
    );
    const h = harness();
    h.ctx.cwd = project;
    await h.handlers.get("session_start")!({}, h.ctx);

    // Bare status advertises the catalog for runtime discovery.
    const status = await execute(h, { action: "status" });
    expect(status.content[0].text).toContain("scout: Fast recon");

    // Running with agent:'scout' applies the persona defaults.
    const result = await execute(h, { task: "map the code", agent: "scout" });
    expect(result.isError).not.toBe(true);
    expect(result.details.results[0].label).toBe("scout");
    expect(result.details.results[0].profile).toBe("explore");

    // Unknown agent fails with guidance.
    await expect(execute(h, { task: "x", agent: "ghost" })).rejects.toThrow(/scout/);

    await h.handlers.get("session_shutdown")!();
    await fs.rm(project, { recursive: true, force: true });
  });

  it("notifies the parent when a background run completes (batched followUp)", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    const started = await execute(h, { task: "bg work", profile: "explore", async: true });
    const id = runId(started.content[0].text);
    // Run finishes; batcher holds successes briefly, then flushes.
    await vi.waitFor(() => {
      const terminal = h.entries.find((entry) => entry.customType === RUN_ENTRY_TYPE && entry.data.id === id && entry.data.type === "terminal");
      expect(terminal).toBeTruthy();
    });
    await vi.waitFor(() => {
      expect(h.sentMessages.length).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    const notification = h.sentMessages[0]!;
    expect(notification.message.customType).toBe("subagent-completion");
    expect(notification.message.content).toContain(id.slice(0, 8));
    expect(notification.options?.deliverAs).toBe("followUp");
    expect(notification.options?.triggerTurn).toBe(true);
    await h.handlers.get("session_shutdown")!();
  });

  it("suppresses the notification when wait already delivered the run", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_DELAY_MS = "100";
    const started = await execute(h, { task: "bg work", profile: "explore", async: true });
    const id = runId(started.content[0].text);
    // Wait consumes the result before the batcher flushes.
    await execute(h, { action: "wait", id });
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(h.sentMessages).toHaveLength(0);
    await h.handlers.get("session_shutdown")!();
  });

  it("foreground runs never notify", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    await execute(h, { task: "fg work", profile: "explore" });
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(h.sentMessages).toHaveLength(0);
    await h.handlers.get("session_shutdown")!();
  });

  it("delivers validated structured output as JSON end-to-end", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_MODE = "schema-good";
    const result = await execute(h, {
      task: "audit files",
      profile: "explore",
      output_schema: { type: "object", required: ["files", "risk"] },
    });
    expect(result.isError).not.toBe(true);
    // Delivery is the machine-readable JSON, not the narrative preamble.
    expect(JSON.parse(result.content[0].text)).toEqual({ files: ["a.ts"], risk: "low" });
    expect(result.details.results[0].structuredOutput).toEqual({ files: ["a.ts"], risk: "low" });
    await h.handlers.get("session_shutdown")!();
  });

  it("schema failure ends partial with the raw text still delivered", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    process.env.FAKE_PI_MODE = "schema-bad";
    const result = await execute(h, {
      task: "audit files",
      profile: "explore",
      output_schema: { type: "object", required: ["files"] },
    });
    expect(result.isError).not.toBe(true); // partial, not failed
    expect(result.content[0].text).toContain("prose");
    expect(result.details.results[0].structuredError).toBeTruthy();
    await h.handlers.get("session_shutdown")!();
  });

  it("rejects worktree actions on runs without changed worktrees", async () => {
    const h = harness();
    await h.handlers.get("session_start")!({}, h.ctx);
    const done = await execute(h, { task: "no trees", profile: "explore", async: true });
    const id = runId(done.content[0].text);
    await execute(h, { action: "wait", id });
    await expect(execute(h, { action: "diff", id })).rejects.toThrow(/no changed worktrees/i);
    await expect(execute(h, { action: "apply", id })).rejects.toThrow(/no changed worktrees/i);
    await h.handlers.get("session_shutdown")!();
  });
});
