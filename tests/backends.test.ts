import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderClaudeSessionLine,
  renderCodexSessionLine,
  resolveBackendSessionFilePath,
  sessionLineRenderer,
  tailSessionFile,
} from "../src/transcript.js";
import { CodexBackend, CodexParser } from "../src/backends/codex.js";
import { ClaudeBackend, ClaudeParser } from "../src/backends/claude.js";
import { PiBackend } from "../src/backends/pi.js";
import { resolveBackend } from "../src/backends/index.js";
import { checkCapabilities } from "../src/backend.js";
import type { TaskSpec } from "../src/types.js";

const launchContext = {
  sessionDir: "/tmp/sessions",
  getPiCommand: (args: string[]) => ({ command: "pi", args }),
};

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    task: "do the thing",
    timeoutMs: 60_000,
    ...overrides,
  } as TaskSpec;
}

/**
 * These fixtures are VERBATIM output captured from the real CLIs
 * (codex-cli 0.144.6 / claude-code 2.1.219), not hand-written guesses.
 */
const CODEX_STREAM = [
  '{"type":"thread.started","thread_id":"019f9607-0327-7c32-aa03-f2affcdd58fb"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\u2019ll list the current directory contents now."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"README.md\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"README.md\\n\\nDONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":37958,"cached_input_tokens":18176,"output_tokens":66,"reasoning_output_tokens":0}}',
].join("\n") + "\n";

const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"47023ea5-66d5-4b7b-b3e6-71883f32d56f","model":"claude-haiku-4-5","tools":["Read"]}',
  '{"type":"assistant","message":{"id":"m1","model":"claude-haiku-4-5","role":"assistant","stop_reason":"stop_sequence","type":"message","usage":{"input_tokens":120,"output_tokens":8,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"CLAUDEPROBE"}]},"session_id":"47023ea5"}',
  '{"is_error":false,"num_turns":1,"session_id":"47023ea5","total_cost_usd":0.0123,"usage":{"input_tokens":120,"output_tokens":8},"subtype":"success","result":"CLAUDEPROBE","type":"result","duration_ms":716}',
].join("\n") + "\n";

describe("backend registry", () => {
  it("resolves each backend by name and caches instances", () => {
    expect(resolveBackend("pi")).toBeInstanceOf(PiBackend);
    expect(resolveBackend("codex")).toBeInstanceOf(CodexBackend);
    expect(resolveBackend("claude")).toBeInstanceOf(ClaudeBackend);
    expect(resolveBackend("codex")).toBe(resolveBackend("codex"));
  });
});

describe("checkCapabilities", () => {
  it("refuses max_cost when the backend cannot report cost", () => {
    const problems = checkCapabilities({ maxCost: 5 }, resolveBackend("codex").capabilities, "codex");
    expect(problems.join(" ")).toMatch(/does not report per-turn cost/);
  });

  it("passes a spec the backend fully supports", () => {
    expect(checkCapabilities({ maxCost: 5 }, resolveBackend("pi").capabilities, "pi")).toEqual([]);
  });

  it("refuses tool restriction on a backend that cannot enforce it", () => {
    const problems = checkCapabilities(
      { tools: ["read"] },
      { ...resolveBackend("codex").capabilities, toolRestriction: false },
      "codex",
    );
    expect(problems.join(" ")).toMatch(/cannot restrict the child's tools/);
  });
});

describe("CodexBackend invocation", () => {
  it("maps read-only profiles onto the OS sandbox", async () => {
    const invocation = await new CodexBackend().buildInvocation(spec({ canWrite: false }), launchContext);
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain("--json");
    const sandboxIndex = invocation.args.indexOf("--sandbox");
    expect(invocation.args[sandboxIndex + 1]).toBe("read-only");
  });

  it("uses workspace-write when the task may write", async () => {
    const invocation = await new CodexBackend().buildInvocation(spec({ canWrite: true }), launchContext);
    const sandboxIndex = invocation.args.indexOf("--sandbox");
    expect(invocation.args[sandboxIndex + 1]).toBe("workspace-write");
  });

  it("folds the system prompt into the prompt (codex has no append flag)", async () => {
    const invocation = await new CodexBackend().buildInvocation(
      spec({ systemPrompt: "You are terse." }),
      launchContext,
    );
    const prompt = invocation.args[invocation.args.length - 1]!;
    expect(prompt).toContain("You are terse.");
    expect(prompt).toContain("do the thing");
  });

  it("exposes no steer command, so steering is refused not ignored", () => {
    const backend = new CodexBackend() as unknown as { steerCommand?: unknown };
    expect(backend.steerCommand).toBeUndefined();
    expect(new CodexBackend().capabilities.steer).toBe(false);
    expect(new CodexBackend().capabilities.gracefulWrapUp).toBe(false);
  });
});

describe("CodexParser against real captured output", () => {
  it("extracts session id, text, usage and terminal state", () => {
    const parser = new CodexParser();
    const updates = parser.feed(CODEX_STREAM);
    const session = updates.find((update) => update.type === "session");
    expect(session).toEqual({ type: "session", sessionId: "019f9607-0327-7c32-aa03-f2affcdd58fb" });
    expect(updates.some((update) => update.type === "agent-settled")).toBe(true);

    const result = parser.finalize(0);
    expect(result.state).toBe("completed");
    expect(result.liveText).toBe("README.md\n\nDONE");
    expect(result.usage.input).toBe(37958);
    expect(result.usage.output).toBe(66);
    expect(result.usage.cacheRead).toBe(18176);
    // Codex reports no dollar cost; it must stay zero rather than be invented.
    expect(result.usage.cost).toBe(0);
    expect(result.sessionId).toBe("019f9607-0327-7c32-aa03-f2affcdd58fb");
    expect(result.transcript).toContain("$ /bin/zsh -lc ls (exit 0)");
  });

  it("treats a truncated stream as partial, preserving paid output", () => {
    const parser = new CodexParser();
    parser.feed(CODEX_STREAM.split("\n").slice(0, 3).join("\n") + "\n");
    const result = parser.finalize(1);
    expect(result.state).toBe("partial");
    expect(result.liveText).toContain("list the current directory");
  });

  it("ignores non-JSON tracing lines without counting parse errors", () => {
    const parser = new CodexParser();
    parser.feed("2026-07-24T21:27:49Z ERROR codex_models_manager: failed to load cache\n");
    const result = parser.finalize(1);
    expect(result.protocol?.parseErrors).toBe(0);
  });
});

describe("ClaudeBackend invocation", () => {
  it("requests stream-json and maps our tool names", async () => {
    const invocation = await new ClaudeBackend().buildInvocation(
      spec({ tools: ["read", "grep", "find"], canWrite: false }),
      launchContext,
    );
    expect(invocation.command).toBe("claude");
    expect(invocation.args).toContain("--print");
    const formatIndex = invocation.args.indexOf("--output-format");
    expect(invocation.args[formatIndex + 1]).toBe("stream-json");
    expect(invocation.args).toContain("Read");
    expect(invocation.args).toContain("Grep");
    expect(invocation.args).toContain("Glob");
    // Read-only tasks also explicitly deny the mutating tools.
    expect(invocation.args).toContain("--disallowedTools");
    expect(invocation.args).toContain("Write");
  });

  it("passes --fork-session only when forking a resume", async () => {
    const plain = await new ClaudeBackend().buildInvocation(spec({ resume: "abc" }), launchContext);
    expect(plain.args).toContain("--resume");
    expect(plain.args).not.toContain("--fork-session");
    const forked = await new ClaudeBackend().buildInvocation(
      spec({ resume: "abc", forkResume: true }),
      launchContext,
    );
    expect(forked.args).toContain("--fork-session");
  });
});

describe("ClaudeParser against real captured output", () => {
  it("extracts session id, final text and reported cost", () => {
    const parser = new ClaudeParser();
    const updates = parser.feed(CLAUDE_STREAM);
    expect(updates.find((update) => update.type === "session")).toEqual({
      type: "session",
      sessionId: "47023ea5-66d5-4b7b-b3e6-71883f32d56f",
    });
    const result = parser.finalize(0);
    expect(result.state).toBe("completed");
    expect(result.liveText).toBe("CLAUDEPROBE");
    // Claude DOES report cost, so max_cost is enforceable.
    expect(result.usage.cost).toBeCloseTo(0.0123, 6);
    expect(result.usage.turns).toBe(1);
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("surfaces a rate-limit / API error as a fatal failure", () => {
    const parser = new ClaudeParser();
    const rateLimited = [
      '{"type":"system","subtype":"init","session_id":"s1","model":"claude-haiku-4-5"}',
      '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You\'ve hit your weekly limit"}],"usage":{"input_tokens":0,"output_tokens":0}},"error":"rate_limit","is_api_error_message":true}',
    ].join("\n") + "\n";
    const updates = parser.feed(rateLimited);
    const fatal = updates.find((update) => update.type === "fatal");
    expect(fatal).toBeTruthy();
    expect((fatal as { error: string }).error).toMatch(/weekly limit/);
    const result = parser.finalize(1);
    expect(result.state).toBe("failed");
    expect(result.errorMessage).toMatch(/weekly limit/);
  });

  it("reports is_error results as failures carrying the message", () => {
    const parser = new ClaudeParser();
    parser.feed('{"type":"system","subtype":"init","session_id":"s1"}\n');
    parser.feed('{"type":"result","is_error":true,"result":"tool limit exceeded","total_cost_usd":0.5,"num_turns":2,"subtype":"error","session_id":"s1"}\n');
    const result = parser.finalize(1);
    expect(result.state).toBe("failed");
    expect(result.errorMessage).toMatch(/tool limit exceeded/);
    // Paid work is still accounted even on failure.
    expect(result.usage.cost).toBeCloseTo(0.5, 6);
  });
});

describe("resolveBackendSessionFilePath", () => {
  it("finds a real codex rollout file by thread id", () => {
    // Written by the live codex probe during development; skip if pruned.
    const threadId = "019f9607-0327-7c32-aa03-f2affcdd58fb";
    const resolved = resolveBackendSessionFilePath("codex", threadId);
    if (!resolved) return; // codex history rotated away; nothing to assert
    expect(resolved).toContain(threadId);
    expect(resolved.endsWith(".jsonl")).toBe(true);
    expect(fs.statSync(resolved).isFile()).toBe(true);
  });

  it("returns undefined for an unknown session id instead of a wrong file", () => {
    expect(resolveBackendSessionFilePath("codex", "definitely-not-a-real-thread-id")).toBeUndefined();
    expect(resolveBackendSessionFilePath("claude", "definitely-not-a-real-session")).toBeUndefined();
  });

  it("requires a sessionDir for the pi backend", () => {
    expect(resolveBackendSessionFilePath("pi", "abc")).toBeUndefined();
  });

  it("resolves a claude project transcript from cwd slug", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-claude-home-"));
    const cwd = "/private/tmp/example-project";
    const projectDir = path.join(dir, ".claude", "projects", cwd.replace(/[/\\]/g, "-"));
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, "sess-123.jsonl");
    fs.writeFileSync(file, "{}\n");
    expect(resolveBackendSessionFilePath("claude", "sess-123", { home: dir, cwd })).toBe(file);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("per-backend transcript renderers", () => {
  it("renders codex rollout entries and skips the permissions preamble", () => {
    const developer = '{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions> sandbox_mode is read-only"}]}}';
    const assistant = '{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"README.md DONE"}]}}';
    const shell = '{"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"}}';
    expect(renderCodexSessionLine(developer)).toBeNull();
    expect(renderCodexSessionLine(assistant)).toBe("assistant: README.md DONE");
    expect(renderCodexSessionLine(shell)).toContain("tool exec_command");
    expect(renderCodexSessionLine("not json")).toBeNull();
  });

  it("renders claude transcript entries and skips bookkeeping", () => {
    const queue = '{"type":"queue-operation","operation":"enqueue","content":"hi"}';
    const assistant = '{"type":"assistant","message":{"content":[{"type":"text","text":"CLAUDEPROBE"}]}}';
    const toolUse = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/x"}}]}}';
    expect(renderClaudeSessionLine(queue)).toBeNull();
    expect(renderClaudeSessionLine(assistant)).toBe("assistant: CLAUDEPROBE");
    expect(renderClaudeSessionLine(toolUse)).toContain("tool Read");
  });

  it("selects the renderer by backend", () => {
    expect(sessionLineRenderer("codex")).toBe(renderCodexSessionLine);
    expect(sessionLineRenderer("claude")).toBe(renderClaudeSessionLine);
    expect(sessionLineRenderer("pi")).not.toBe(renderCodexSessionLine);
  });

  it("tails a real codex rollout file into readable lines", () => {
    const resolved = resolveBackendSessionFilePath("codex", "019f9607-369f-7f53-a7ee-de5d8de2c0f1");
    if (!resolved) return; // history rotated
    const tailed = tailSessionFile(resolved, undefined, undefined, sessionLineRenderer("codex"));
    expect(tailed.status).toBe("ok");
    expect(tailed.lines.join("\n")).toMatch(/assistant:/);
  });
});
