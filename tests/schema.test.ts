import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { assertObjectToolSchema, SubagentParamsSchema } from "../src/schema.js";
import { validateSubagentRequest } from "../src/policy.js";

const parent = {
  cwd: "/tmp",
  availableTools: ["read", "grep", "find", "ls", "bash"],
  activeTools: ["read", "grep", "find", "ls", "bash"],
};

describe("SubagentParamsSchema", () => {
  it("exposes JSON Schema type object for providers", () => {
    expect(SubagentParamsSchema.type).toBe("object");
    expect(() => assertObjectToolSchema(SubagentParamsSchema)).not.toThrow();
    // Must not be a bare anyOf/union at the top level.
    expect("=" in SubagentParamsSchema ? null : (SubagentParamsSchema as any).anyOf).toBeUndefined();
  });

  it("accepts single task", () => {
    expect(Value.Check(SubagentParamsSchema, { task: "do thing" })).toBe(true);
  });

  it("accepts parallel tasks", () => {
    expect(
      Value.Check(SubagentParamsSchema, {
        tasks: [{ task: "a" }, { task: "b", profile: "explore" }],
        async: true,
      }),
    ).toBe(true);
  });

  it("accepts management actions", () => {
    expect(Value.Check(SubagentParamsSchema, { action: "wait", id: "abc" })).toBe(true);
    expect(Value.Check(SubagentParamsSchema, { action: "cancel" })).toBe(true);
    expect(Value.Check(SubagentParamsSchema, { action: "status", id: "x" })).toBe(true);
  });

  it("rejects empty task", () => {
    expect(Value.Check(SubagentParamsSchema, { task: "" })).toBe(false);
  });

  it("rejects unknown fields on strict objects", () => {
    expect(Value.Check(SubagentParamsSchema, { task: "x", nope: true })).toBe(false);
  });

  it("rejects action combined with task payload in policy validation", () => {
    // Provider schemas must stay type:object, so mode exclusivity is policy-side.
    expect(Value.Check(SubagentParamsSchema, { action: "status", task: "nope" })).toBe(true);
    const validated = validateSubagentRequest({ action: "status", task: "nope" } as any, parent);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.error).toMatch(/exactly one/i);
  });

  it("requires one of task, tasks, or action", () => {
    const validated = validateSubagentRequest({} as any, parent);
    expect(validated.ok).toBe(false);
  });
});
