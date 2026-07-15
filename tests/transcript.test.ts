import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderSessionLine, resolveSessionFilePath, tailSessionFile } from "../src/transcript.js";

function entry(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function userMsg(text: string): string {
  return entry({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  });
}

function assistantMsg(text: string, tools: Array<{ name: string; args?: unknown }> = []): string {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text });
  for (const tool of tools) {
    content.push({ type: "toolCall", id: `call_${tool.name}`, name: tool.name, arguments: tool.args ?? {} });
  }
  return entry({
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content, timestamp: Date.now() },
  });
}

function toolResult(name: string, text: string, isError = false): string {
  return entry({
    type: "message",
    id: "tr1",
    parentId: "a1",
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolName: name,
      content: [{ type: "text", text }],
      isError,
      timestamp: Date.now(),
    },
  });
}

describe("tailSessionFile", () => {
  it("returns missing for nonexistent path", () => {
    expect(tailSessionFile("/nonexistent/pi-subagent-nowhere.jsonl")).toEqual({
      status: "missing",
      lines: [],
    });
  });

  it("returns empty for an empty file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
    try {
      const file = path.join(dir, "empty.jsonl");
      await fs.writeFile(file, "");
      expect(tailSessionFile(file)).toEqual({ status: "empty", lines: [] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("renders role-prefixed and tool markers; skips garbage and header", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
    try {
      const file = path.join(dir, "sess.jsonl");
      await fs.writeFile(
        file,
        [
          entry({ type: "session", version: 3, id: "sess", timestamp: "t", cwd: "/" }),
          userMsg("hello world"),
          "not-json\n",
          assistantMsg("thinking out loud", [{ name: "read", args: { path: "a.ts" } }]),
          toolResult("read", "export const x = 1;"),
        ].join(""),
      );
      const result = tailSessionFile(file);
      expect(result.status).toBe("ok");
      expect(result.lines.some((l) => l.startsWith("user: hello"))).toBe(true);
      expect(result.lines.some((l) => l.startsWith("assistant: thinking"))).toBe(true);
      expect(result.lines.some((l) => l.startsWith("→ read"))).toBe(true);
      expect(result.lines.some((l) => l.startsWith("← read"))).toBe(true);
      expect(result.lines.every((l) => !l.includes("not-json"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("handles partial trailing lines and mid-file window starts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
    try {
      const file = path.join(dir, "partial.jsonl");
      // Many complete lines then a partial trailing line without newline.
      const lines = Array.from({ length: 40 }, (_, i) => userMsg(`line-${i}`)).join("");
      await fs.writeFile(file, `${lines}{"type":"message","incomplete`);
      const result = tailSessionFile(file, 10, 2_000);
      expect(result.status).toBe("ok");
      // Partial trailing entry skipped; last complete lines kept.
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.lines.every((l) => l.startsWith("user:"))).toBe(true);
      expect(result.lines.some((l) => l.includes("line-39"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("respects maxLines and bounded byte window (rotation/oversize)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
    try {
      const file = path.join(dir, "big.jsonl");
      // Pad with long unique payloads so a small byte window cannot cover all.
      const chunks: string[] = [entry({ type: "session", version: 3, id: "big", timestamp: "t", cwd: "/" })];
      for (let i = 0; i < 50; i++) {
        chunks.push(userMsg(`pad-${i}-${"x".repeat(120)}`));
      }
      chunks.push(userMsg("tail-marker-ZZZ"));
      await fs.writeFile(file, chunks.join(""));
      const result = tailSessionFile(file, 5, 1_500);
      expect(result.status).toBe("ok");
      expect(result.lines.length).toBeLessThanOrEqual(5);
      expect(result.lines.at(-1)).toContain("tail-marker-ZZZ");
      // Earliest lines fall outside the byte window / maxLines.
      expect(result.lines.some((l) => l.includes("pad-0-"))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSessionFilePath", () => {
  it("prefers exact id.jsonl then timestamped basename inclusion", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-sess-"));
    try {
      const id = "019f-test-session-id";
      const stamped = path.join(dir, `2026-07-15T12-00-00-000Z_${id}.jsonl`);
      await fs.writeFile(stamped, entry({ type: "session", id, version: 3, timestamp: "t", cwd: "/" }));
      expect(resolveSessionFilePath(dir, id)).toBe(stamped);

      const exact = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(exact, entry({ type: "session", id, version: 3, timestamp: "t", cwd: "/" }));
      expect(resolveSessionFilePath(dir, id)).toBe(exact);

      expect(resolveSessionFilePath(dir, "no-such-id")).toBeUndefined();
      expect(resolveSessionFilePath("/nonexistent/dir", id)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderSessionLine", () => {
  it("skips unparseable and non-message entries", () => {
    expect(renderSessionLine("")).toBeNull();
    expect(renderSessionLine("{nope")).toBeNull();
    expect(renderSessionLine(JSON.stringify({ type: "session", id: "x" }))).toBeNull();
    expect(renderSessionLine(JSON.stringify({ type: "model_change", provider: "p", modelId: "m" }))).toBeNull();
  });

  it("marks tool errors", () => {
    const line = renderSessionLine(
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true },
      }),
    );
    expect(line).toContain("← bash [error]");
    expect(line).toContain("boom");
  });
});
