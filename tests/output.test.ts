import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { OutputManager } from "../src/output.js";
import type { TaskResult } from "../src/types.js";
import { emptyUsage } from "../src/types.js";

function task(text: string, extra: Partial<TaskResult> = {}): TaskResult {
  return {
    label: "t", task: "x", state: "completed", exitCode: 0, stderr: "", usage: emptyUsage(),
    messages: [{ role: "assistant", content: [{ type: "text", text: text.slice(0, Math.ceil(text.length / 2)) }, { type: "text", text: text.slice(Math.ceil(text.length / 2)) }] } as any],
    protocol: { headerSeen: true, assistantEndSeen: true, agentEndSeen: true, validEvents: 1, parseErrors: 0 },
    ...extra,
  };
}

describe("OutputManager", () => {
  const manager = new OutputManager(defaultConfig);

  it("never exceeds exact UTF-8 byte and line caps", () => {
    for (const input of ["x".repeat(100_000), "🚀".repeat(30_000), Array(3_000).fill("line").join("\n")]) {
      const result = manager.capOutputForDelivery([task(input)]);
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(defaultConfig.maxResultBytes);
      expect(result.text.split("\n").length).toBeLessThanOrEqual(defaultConfig.maxResultLines);
      expect(result.totalBytes).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.totalLines).toBe(result.text.split("\n").length);
      expect(result.text).not.toContain("�");
    }
  });

  it("concatenates every final assistant text part", () => {
    expect(manager.capOutputForDelivery([task("hello world")]).text).toBe("hello world");
  });

  it("file-only returns pointers and never inline transcript", () => {
    const result = manager.capOutputForDelivery([
      task("TOP SECRET INLINE BODY", { outputMode: "file-only", outputFile: "/tmp/report.md", sessionId: "child" }),
    ]);
    expect(result.text).toContain("/tmp/report.md");
    expect(result.text).toContain("child");
    expect(result.text).not.toContain("TOP SECRET");
  });

  it("fairly caps many large parallel sections globally", () => {
    const result = manager.capOutputForDelivery(Array.from({ length: 8 }, (_, i) => task(`${i}:` + "x".repeat(50_000))), true);
    expect(result.cappedResults).toHaveLength(8);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(defaultConfig.maxResultBytes);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(defaultConfig.maxResultLines);
    expect(result.cappedResults.every((item) => item.capped)).toBe(true);
  });

  it("status preview is byte-capped metadata only", () => {
    const preview = manager.makeStatusPreview({ id: "🚀".repeat(100), state: "completed", mode: "single", results: [] } as any, 40);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(40);
  });
});
