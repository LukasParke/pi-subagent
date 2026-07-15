import { describe, expect, it } from "vitest";
import {
  checkAgainstSchema,
  extractStructuredResult,
  isPlausibleSchema,
  repairDoubleEncodedText,
  repairMessage,
  schemaContract,
} from "../src/structured.js";

describe("schema validation subset", () => {
  const schema = {
    type: "object",
    required: ["files", "risk"],
    properties: {
      files: { type: "array", items: { type: "string" } },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      count: { type: "integer" },
    },
  };

  it("accepts conforming values", () => {
    expect(checkAgainstSchema({ files: ["a.ts"], risk: "low" }, schema).ok).toBe(true);
    expect(checkAgainstSchema({ files: [], risk: "high", count: 3 }, schema).ok).toBe(true);
  });

  it("reports missing required, wrong types, enum misses with paths", () => {
    const missing = checkAgainstSchema({ files: [] }, schema);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join()).toContain('missing required property "risk"');

    const wrongType = checkAgainstSchema({ files: "not-array", risk: "low" }, schema);
    expect(wrongType.errors.join()).toContain("$.files");

    const badEnum = checkAgainstSchema({ files: [], risk: "extreme" }, schema);
    expect(badEnum.errors.join()).toContain("enum");

    const badItem = checkAgainstSchema({ files: [1], risk: "low" }, schema);
    expect(badItem.errors.join()).toContain("$.files[0]");

    const badInt = checkAgainstSchema({ files: [], risk: "low", count: 1.5 }, schema);
    expect(badInt.errors.join()).toContain("$.count");
  });

  it("ignores unknown keywords rather than rejecting", () => {
    const exotic = { type: "object", patternProperties: { "^x": {} }, minProperties: 1 };
    expect(checkAgainstSchema({ anything: 1 }, exotic).ok).toBe(true);
  });

  it("supports const and union types", () => {
    expect(checkAgainstSchema("fixed", { const: "fixed" }).ok).toBe(true);
    expect(checkAgainstSchema("other", { const: "fixed" }).ok).toBe(false);
    expect(checkAgainstSchema(null, { type: ["string", "null"] }).ok).toBe(true);
  });

  it("isPlausibleSchema rejects non-objects and malformed shapes", () => {
    expect(isPlausibleSchema({ type: "object" })).toBe(true);
    expect(isPlausibleSchema({})).toBe(true);
    expect(isPlausibleSchema(null)).toBe(false);
    expect(isPlausibleSchema([])).toBe(false);
    expect(isPlausibleSchema({ type: 42 })).toBe(false);
    expect(isPlausibleSchema({ required: "files" })).toBe(false);
  });
});

describe("structured result extraction", () => {
  it("prefers the last json:result fence", () => {
    const text = 'Draft:\n```json:result\n{"v": 1}\n```\nFinal:\n```json:result\n{"v": 2}\n```';
    expect(extractStructuredResult(text).value).toEqual({ v: 2 });
  });

  it("falls back to plain json fence, then trailing bare JSON", () => {
    expect(extractStructuredResult('Text\n```json\n{"a": true}\n```').value).toEqual({ a: true });
    expect(extractStructuredResult('Narrative done.\n{"b": [1, 2]}').value).toEqual({ b: [1, 2] });
  });

  it("reports unparseable fences and empty inputs", () => {
    const broken = extractStructuredResult("```json:result\n{nope\n```");
    expect(broken.value).toBeUndefined();
    expect(broken.raw).toContain("{nope");
    expect(extractStructuredResult(undefined)).toEqual({});
    expect(extractStructuredResult("just prose")).toEqual({});
  });

  it("contract and repair messages carry the essentials", () => {
    const contract = schemaContract({ type: "object", required: ["x"] });
    expect(contract).toContain("json:result");
    expect(contract).toContain('"required"');
    const repair = repairMessage(["$: missing required property \"x\""]);
    expect(repair).toContain("failed validation");
    expect(repair).toContain("json:result");
  });
});

describe("arg repair (double-encoded text)", () => {
  it("decodes fully escaped payloads", () => {
    expect(repairDoubleEncodedText("line1\\nline2")).toBe("line1\nline2");
    expect(repairDoubleEncodedText('say \\"hi\\" now')).toBe('say "hi" now');
    // Companion escapes decode when a high-signal escape is present…
    expect(repairDoubleEncodedText('a\\tb\\nc')).toBe("a\tb\nc");
    expect(repairDoubleEncodedText('caf\\u00e9 says \\"hi\\"')).toBe('café says "hi"');
    // …but lone \t or \u without \n or \" is not enough signal (Windows paths, regex).
    expect(repairDoubleEncodedText("tab\\tsep")).toBe("tab\\tsep");
  });

  it("leaves normal and ambiguous text untouched", () => {
    expect(repairDoubleEncodedText("plain task text")).toBe("plain task text");
    // Real newlines present: mixed content is too ambiguous to touch.
    expect(repairDoubleEncodedText("real\nnewline with \\n literal")).toBe("real\nnewline with \\n literal");
    // Windows path with backslashes but no escape-sequence pattern.
    expect(repairDoubleEncodedText("C:\\Users\\path")).toBe("C:\\Users\\path");
    expect(repairDoubleEncodedText("a\\b")).toBe("a\\b");
    expect(repairDoubleEncodedText("")).toBe("");
  });
});
