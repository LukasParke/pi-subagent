import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { SubagentParamsSchema } from "../src/schema.js";

describe("SubagentParamsSchema", () => {
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

  it("rejects action combined with task payload via schema shape", () => {
    // Discriminated objects do not allow task on status branch
    expect(
      Value.Check(SubagentParamsSchema, { action: "status", task: "nope" } as any),
    ).toBe(false);
  });
});
