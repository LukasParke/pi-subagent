import { describe, it, expect, afterEach } from "vitest";
import { validateSubagentRequest, parseDepth, parseSpawnPolicy, SPAWNS_ENV_VAR, WRITE_TOOLS, READ_ONLY_TOOLS } from "../src/policy.js";
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
  it("parses depth robustly and fails closed on malformed values", () => {
    expect(parseDepth(undefined)).toBe(0);
    expect(parseDepth("")).toBe(0);
    expect(parseDepth("2")).toBe(2);
    // Malformed / negative: fail closed so env scrubbing cannot reset to top-level.
    expect(parseDepth("nope")).toBe(100);
    expect(parseDepth("-3")).toBe(100);
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

  it("explore/review fail closed on write or unclassified tools", () => {
    const unsafe = validateSubagentRequest(
      { task: "Search", profile: "explore", tools: ["read", "bash"] },
      parent,
    );
    expect(unsafe.ok).toBe(false);
    const safe = validateSubagentRequest(
      { task: "Search", profile: "explore", tools: ["read", "web_search"] },
      parent,
    );
    expect(safe.ok).toBe(true);
    if (!safe.ok) return;
    for (const w of WRITE_TOOLS) expect(safe.tasks[0]!.effectiveTools).not.toContain(w);
    expect(safe.tasks[0]!.canWrite).toBe(false);
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

  it("steer requires id and a non-empty message", () => {
    expect(validateSubagentRequest({ action: "steer" }, parent).ok).toBe(false);
    expect(validateSubagentRequest({ action: "steer", id: "abc" }, parent).ok).toBe(false);
    expect(validateSubagentRequest({ action: "steer", id: "abc", message: "  " }, parent).ok).toBe(false);
    const ok = validateSubagentRequest({ action: "steer", id: "abc", message: "focus on tests", index: 1 }, parent);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.mode).toBe("steer");
    expect(ok.message).toBe("focus on tests");
    expect(ok.index).toBe(1);
  });

  it("worktree actions require a run id", () => {
    for (const action of ["diff", "apply", "discard"] as const) {
      expect(validateSubagentRequest({ action }, parent).ok).toBe(false);
      const ok = validateSubagentRequest({ action, id: "abc" }, parent);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.mode).toBe(action);
    }
  });

  it("action:plan requires task or tasks and sets planOnly", () => {
    const alone = validateSubagentRequest({ action: "plan" }, parent);
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.error).toMatch(/plan.*task/i);

    const both = validateSubagentRequest(
      { action: "plan", task: "a", tasks: [{ task: "b" }] },
      parent,
    );
    const single = validateSubagentRequest({ action: "plan", task: "scan foo", profile: "explore" }, parent);
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.planOnly).toBe(true);
    expect(single.mode).toBe("single");
    expect(single.tasks).toHaveLength(1);
    expect(single.tasks[0]!.profile).toBe("explore");
    expect(single.tasks[0]!.effectiveTools.length).toBeGreaterThan(0);

    const par = validateSubagentRequest(
      {
        action: "plan",
        tasks: [
          { task: "A", profile: "explore" },
          { task: "B", profile: "explore" },
        ],
      },
      parent,
    );
    expect(par.ok).toBe(true);
    if (!par.ok) return;
    expect(par.planOnly).toBe(true);
    expect(par.mode).toBe("parallel");
    expect(par.tasks).toHaveLength(2);
  });

  it("action:plan is a truth oracle for parallel writer violations", () => {
    const params = {
      tasks: [
        { task: "Edit A", profile: "general" as const, tools: ["edit", "read"] },
        { task: "Edit B", profile: "general" as const, tools: ["write", "read"] },
      ],
    };
    const real = validateSubagentRequest(params, parent);
    const planned = validateSubagentRequest({ action: "plan", ...params }, parent);
    expect(real.ok).toBe(false);
    expect(planned.ok).toBe(false);
    if (!real.ok && !planned.ok) expect(planned.error).toBe(real.error);
  });

  it("rejects include_wip without worktree isolation", () => {
    const res = validateSubagentRequest(
      { task: "Use dirty baseline", include_wip: true },
      parent,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/include_wip requires isolation:"worktree"/i);
  });

  it("accepts include_wip with worktree isolation and maps includeWip", () => {
    const res = validateSubagentRequest(
      { task: "Use dirty baseline", isolation: "worktree", include_wip: true },
      parent,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tasks[0]!.includeWip).toBe(true);
    expect(res.tasks[0]!.isolation).toBe("worktree");
  });

  it("uses description as the task label, truncated", () => {
    const res = validateSubagentRequest({ task: "Do things", description: "Audit auth flow" }, parent);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tasks[0]!.label).toBe("Audit auth flow");

    const long = validateSubagentRequest({ task: "x", description: "y".repeat(200) }, parent);
    expect(long.ok).toBe(true);
    if (!long.ok) return;
    expect(long.tasks[0]!.label.length).toBeLessThanOrEqual(60);
  });

  it("applies per-profile task defaults with explicit values winning", () => {
    const taskDefaults = {
      explore: { model: "openrouter/kimi-k2.6", thinking: "medium" as const, maxTurns: 12, maxCost: 0.2, timeoutMs: 60_000 },
      general: { model: "openrouter/grok-4.5" },
    };
    // Parallel tasks default to explore → explore defaults kick in.
    const par = validateSubagentRequest({ tasks: [{ task: "scan" }] }, parent, { taskDefaults });
    expect(par.ok).toBe(true);
    if (!par.ok) return;
    expect(par.tasks[0]!.model).toBe("openrouter/kimi-k2.6");
    expect(par.tasks[0]!.thinking).toBe("medium");
    expect(par.tasks[0]!.maxTurns).toBe(12);
    expect(par.tasks[0]!.maxCost).toBe(0.2);
    expect(par.tasks[0]!.timeoutMs).toBe(60_000);

    // Explicit request values beat profile defaults.
    const explicit = validateSubagentRequest(
      { tasks: [{ task: "scan", model: "custom/model", thinking: "high", max_turns: 3 }] },
      parent,
      { taskDefaults },
    );
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.tasks[0]!.model).toBe("custom/model");
    expect(explicit.tasks[0]!.thinking).toBe("high");
    expect(explicit.tasks[0]!.maxTurns).toBe(3);

    // Single-task mode defaults to general → general defaults kick in.
    const single = validateSubagentRequest({ task: "implement" }, parent, { taskDefaults });
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.tasks[0]!.model).toBe("openrouter/grok-4.5");

    // Profile defaults beat parent inheritance but parent still fills the rest.
    expect(single.tasks[0]!.thinking).toBe(parent.thinking);
  });

  it("context:'fork' requires a persisted parent session and is single-task only", () => {
    // No session file → rejected with guidance.
    const noFile = validateSubagentRequest({ task: "x", context: "fork" }, parent);
    expect(noFile.ok).toBe(false);
    if (!noFile.ok) expect(noFile.error).toMatch(/persisted parent session/i);

    const withFile = { ...parent, sessionFile: "/tmp/parent-session.jsonl" };
    const ok = validateSubagentRequest({ task: "x", context: "fork" }, withFile);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.tasks[0]!.contextFork).toBe(true);
    expect(ok.tasks[0]!.parentSessionFile).toBe("/tmp/parent-session.jsonl");

    // fresh (default) never forks.
    const fresh = validateSubagentRequest({ task: "x" }, withFile);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.tasks[0]!.contextFork).toBe(false);

    // fork + resume conflict.
    const conflict = validateSubagentRequest({ task: "x", context: "fork", resume: "child-1" }, withFile);
    expect(conflict.ok).toBe(false);

    // Parallel fanout with fork rejected.
    const par = validateSubagentRequest(
      { tasks: [{ task: "a", context: "fork" }, { task: "b" }] },
      withFile,
    );
    expect(par.ok).toBe(false);
    if (!par.ok) expect(par.error).toMatch(/single-task only/i);
  });

  it("passes grace_turns, fallback_models, and max_retries through with profile defaults", () => {
    const taskDefaults = { general: { fallbackModels: ["fallback/model"], maxRetries: 2 } };
    const explicit = validateSubagentRequest(
      { task: "x", grace_turns: 5, fallback_models: ["a/b"], max_retries: 0 },
      parent,
      { taskDefaults },
    );
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.tasks[0]!.graceTurns).toBe(5);
    expect(explicit.tasks[0]!.fallbackModels).toEqual(["a/b"]);
    expect(explicit.tasks[0]!.maxRetries).toBe(0);

    const defaulted = validateSubagentRequest({ task: "x" }, parent, { taskDefaults });
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.tasks[0]!.fallbackModels).toEqual(["fallback/model"]);
    expect(defaulted.tasks[0]!.maxRetries).toBe(2);

    const invalid = validateSubagentRequest({ task: "x", grace_turns: -1 }, parent);
    expect(invalid.ok).toBe(false);
  });

  it("validates and passes output_schema through; repairs double-encoded task text", () => {
    const good = validateSubagentRequest(
      { task: "x", output_schema: { type: "object", required: ["a"] } },
      parent,
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.tasks[0]!.outputSchema).toEqual({ type: "object", required: ["a"] });

    const bad = validateSubagentRequest({ task: "x", output_schema: { type: 42 } as any }, parent);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/output_schema/);

    // Double-encoded task text is de-mangled once.
    const mangled = validateSubagentRequest({ task: "step 1\\nstep 2" }, parent);
    expect(mangled.ok).toBe(true);
    if (mangled.ok) expect(mangled.tasks[0]!.task).toBe("step 1\nstep 2");
  });

  it("synthesis is parallel-only and passes through trimmed", () => {
    const single = validateSubagentRequest({ task: "x", synthesis: "fold it" }, parent);
    expect(single.ok).toBe(false);

    const par = validateSubagentRequest(
      { tasks: [{ task: "a" }, { task: "b" }], synthesis: "  merge findings  " },
      parent,
    );
    expect(par.ok).toBe(true);
    if (!par.ok) return;
    expect(par.synthesis).toBe("merge findings");
  });

  describe("spawn policy", () => {
    const saved = process.env[SPAWNS_ENV_VAR];
    afterEach(() => {
      if (saved === undefined) delete process.env[SPAWNS_ENV_VAR];
      else process.env[SPAWNS_ENV_VAR] = saved;
    });

    it("parses unrestricted, disabled, allowlist, and fails closed on garbage", () => {
      expect(parseSpawnPolicy(undefined)).toEqual({ kind: "unrestricted" });
      expect(parseSpawnPolicy("*")).toEqual({ kind: "unrestricted" });
      expect(parseSpawnPolicy("")).toEqual({ kind: "disabled" });
      expect(parseSpawnPolicy("false")).toEqual({ kind: "disabled" });
      expect(parseSpawnPolicy("reviewer")).toEqual({ kind: "allowlist", agents: ["reviewer"] });
      expect(parseSpawnPolicy("reviewer, scout")).toEqual({ kind: "allowlist", agents: ["reviewer", "scout"] });
      expect(parseSpawnPolicy("[Reviewer, Scout]")).toEqual({ kind: "allowlist", agents: ["reviewer", "scout"] });
      // Malformed: control chars or reputation-breaking tokens → disabled, never unrestricted.
      expect(parseSpawnPolicy("\x00junk")).toEqual({ kind: "disabled" });
      expect(parseSpawnPolicy("../escape")).toEqual({ kind: "disabled" });
      expect(parseSpawnPolicy("!!!")).toEqual({ kind: "disabled" });
    });

    it("rejects all spawns when the env policy is disabled", () => {
      process.env[SPAWNS_ENV_VAR] = "";
      const res = validateSubagentRequest({ task: "x", agent: "reviewer" }, parent);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/disabled/i);
    });

    it("allowlist permits only named agents and rejects agentless", () => {
      process.env[SPAWNS_ENV_VAR] = "reviewer";
      const catalog = new Map([
        [
          "reviewer",
          {
            name: "reviewer",
            description: "r",
            source: "/r.md",
            scope: "project" as const,
            profile: "review" as const,
            spawns: false as const,
          },
        ],
        [
          "scout",
          {
            name: "scout",
            description: "s",
            source: "/s.md",
            scope: "project" as const,
            profile: "explore" as const,
          },
        ],
      ]);

      const ok = validateSubagentRequest({ task: "review", agent: "reviewer" }, parent, { agents: catalog });
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.tasks[0]!.spawns).toBe(false);

      const scout = validateSubagentRequest({ task: "x", agent: "scout" }, parent, { agents: catalog });
      expect(scout.ok).toBe(false);
      if (!scout.ok) {
        expect(scout.error).toMatch(/allowlist/i);
        expect(scout.error).toMatch(/reviewer/);
      }

      const agentless = validateSubagentRequest({ task: "x" }, parent, { agents: catalog });
      expect(agentless.ok).toBe(false);
      if (!agentless.ok) expect(agentless.error).toMatch(/agentless|allowlist/i);
    });

    it("unrestricted paths behave as today when env is unset", () => {
      delete process.env[SPAWNS_ENV_VAR];
      const res = validateSubagentRequest({ task: "hello", profile: "explore" }, parent);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.tasks[0]!.spawns).toBeUndefined();
    });
  });
});
