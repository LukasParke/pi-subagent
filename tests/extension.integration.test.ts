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
    custom: vi.fn(),
  };
  const ctx = {
    cwd: process.cwd(), hasUI: false, ui, model: { provider: "fake", id: "model" },
    sessionManager: {
      getSessionFile: () => "/tmp/root-session.jsonl",
      getSessionId: () => "root-session",
      getBranch: () => entries,
    },
  };
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (definition: any) => { tool = definition; },
    registerCommand: vi.fn(),
    appendEntry: (customType: string, data: unknown) => entries.push({
      type: "custom", customType, data, id: `e-${entries.length}`, parentId: null, timestamp: new Date().toISOString(),
    }),
    getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name })),
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "off",
  };
  register(pi as any);
  return { get tool() { return tool; }, handlers, entries, ctx, pi } as Harness;
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

  beforeEach(async () => {
    originalPath = process.env.PATH;
    originalMode = process.env.FAKE_PI_MODE;
    originalDelay = process.env.FAKE_PI_DELAY_MS;
    bin = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-bin-"));
    const fake = path.resolve("tests/helpers/fake-pi.mjs");
    const script = `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`;
    await fs.writeFile(path.join(bin, "pi"), script, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.FAKE_PI_MODE = "success";
    delete process.env.FAKE_PI_DELAY_MS;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalMode === undefined) delete process.env.FAKE_PI_MODE; else process.env.FAKE_PI_MODE = originalMode;
    if (originalDelay === undefined) delete process.env.FAKE_PI_DELAY_MS; else process.env.FAKE_PI_DELAY_MS = originalDelay;
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
});
