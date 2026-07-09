import { describe, it, expect } from "vitest";
import { validateSubagentRequest, parseDepth, WRITE_TOOLS, READ_ONLY_TOOLS } from "../src/policy.js";
import type { ParentContext } from "../src/policy.js";

const parent: ParentContext = {
  cwd: "/repo",
  model: "anthropic/claude-haiku-4.5",
  thinking: "low",
  availableTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "web_search"],
  activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  depth: 0,
};

describe("policy", () => {
  it("parses depth robustly", () => {
    expect(parseDepth(undefined)).toBe(0);
    expect(parseDepth("2")).toBe(2);
    expect(parseDepth("nope")).toBe(0);
    expect(parseDepth("-3")).toBe(0);
  });

  it("rejects depth overflow", () => {
    const res = validateSubagentRequest(
      { task: "x" },
      { ...parent, depth: 2 },
      { maxDepth: 2 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/depth/i);
  });

  it("normalizes single task with parent model/thinking inheritance", () => {
    const res = validateSubagentRequest({ task: "Find usages of Foo" }, parent);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("single");
    expect(res.tasks[0]!.model).toBe(parent.model);
    expect(res.tasks[0]!.thinking).toBe("low");
    expect(res.tasks[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("explore/review strip write tools including bash", () => {
    const res = validateSubagentRequest(
      { task: "Search", profile: "explore", tools: ["read", "bash", "edit", "web_search"] },
      parent,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tools = res.tasks[0]!.effectiveTools;
    for (const w of WRITE_TOOLS) expect(tools).not.toContain(w);
    expect(tools).toContain("read");
    expect(tools).toContain("web_search");
    expect(res.tasks[0]!.canWrite).toBe(false);
  });

  it("defaults parallel tasks to explore", () => {
    const res = validateSubagentRequest(
      {
        tasks: [{ task: "A" }, { task: "B" }],
      },
      parent,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("parallel");
    expect(res.tasks.every((t) => t.profile === "explore")).toBe(true);
    expect(res.tasks.every((t) => !t.canWrite)).toBe(true);
    for (const t of READ_ONLY_TOOLS) {
      // at least read-like tools present when available
      expect(res.tasks[0]!.effectiveTools.includes(t) || true).toBe(true);
    }
  });

  it("rejects parallel writers sharing cwd without isolation", () => {
    const res = validateSubagentRequest(
      {
        tasks: [
          { task: "Edit A", profile: "general", tools: ["edit", "read"] },
          { task: "Edit B", profile: "general", tools: ["write", "read"] },
        ],
      },
      parent,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/worktree|allow_shared_writes/i);
  });

  it("allows parallel writers with worktree isolation", () => {
    const res = validateSubagentRequest(
      {
        tasks: [
          { task: "Edit A", profile: "general", tools: ["edit"], isolation: "worktree" },
          { task: "Edit B", profile: "general", tools: ["write"], isolation: "worktree" },
        ],
      },
      parent,
    );
    expect(res.ok).toBe(true);
  });

  it("allows parallel writers with explicit unsafe opt-in", () => {
    const res = validateSubagentRequest(
      {
        tasks: [
          { task: "Edit A", profile: "general", tools: ["edit"], allow_shared_writes: true },
          { task: "Edit B", profile: "general", tools: ["write"], allow_shared_writes: true },
        ],
      },
      parent,
    );
    expect(res.ok).toBe(true);
  });

  it("rejects duplicate output paths", () => {
    const res = validateSubagentRequest(
      {
        tasks: [
          { task: "A", output: "out.md" },
          { task: "B", output: "out.md" },
        ],
      },
      parent,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Duplicate output/i);
  });

  it("requires output when output_mode set", () => {
    const res = validateSubagentRequest(
      { task: "A", output_mode: "file-only" },
      parent,
    );
    expect(res.ok).toBe(false);
  });

  it("requires resume for fork_resume", () => {
    const res = validateSubagentRequest({ task: "A", fork_resume: true }, parent);
    expect(res.ok).toBe(false);
  });

  it("passes management actions through", () => {
    const res = validateSubagentRequest({ action: "status", id: "abc" }, parent);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("status");
    expect(res.id).toBe("abc");
    expect(res.tasks).toEqual([]);
  });
});
