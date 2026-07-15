#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === filename || process.argv[1]?.endsWith("fake-pi.mjs");
const header = { type: "session", version: 3, id: "test-session-123", timestamp: new Date().toISOString(), cwd: process.cwd() };
const message = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }, { type: "text", text: " world!" }],
    api: "fake", provider: "fake", model: "fake/model", stopReason: "stop", timestamp: Date.now(),
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 15,
      cost: { input: 0.0004, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
  },
};
const agentEnd = { type: "agent_end", messages: [message.message] };
const agentSettled = { type: "agent_settled" };

if (isMain) {
  // Emulates `pi --mode rpc`: JSONL commands on stdin, events + responses on stdout.
  // The parent runner sends {type:"prompt"} then {type:"get_state"}, may send
  // {type:"steer"} mid-run, and closes stdin after agent_settled.
  const mode = process.env.FAKE_PI_MODE || "success";
  const delay = Number(process.env.FAKE_PI_DELAY_MS || 0);
  const emit = (value, newline = true) => process.stdout.write(JSON.stringify(value) + (newline ? "\n" : ""));
  let promptSeen = false;
  let promptCount = 0;
  const steered = [];

  const runScript = async () => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (mode === "signal") return; // never respond; killed by signal
    if (mode === "error") { process.stderr.write("Some stderr\n"); process.exit(1); return; }
    if (mode === "incomplete") { emit(header); process.exit(0); return; }
    if (mode === "prompt-rejected") {
      emit({ type: "response", command: "prompt", success: false, error: "prompt rejected by fake" });
      return; // stays alive (idle) like real RPC mode; parent must stop it
    }
    if (mode === "nonzero-complete") { emit(header); emit(message); emit(agentEnd); emit(agentSettled); process.exit(1); return; }
    if (mode === "provider-error") {
      emit(header);
      emit({ ...message, message: { ...message.message, stopReason: "error", errorMessage: "provider failed" } });
      emit(agentEnd);
      emit(agentSettled);
      process.exit(0);
      return;
    }
    if (mode === "truncated" || mode === "retry") {
      // Intermediate agent_end with willRetry, then settle. Used to verify we wait
      // for agent_settled rather than racing agent_end.
      emit(header);
      emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "retrying" },
      });
      emit(message);
      emit({ type: "agent_end", willRetry: true, messages: [message.message] });
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_PI_PAUSE_MS || 50)));
      emit(agentEnd);
      emit(agentSettled);
      process.exit(0);
      return;
    }
    if (mode === "legacy-no-settled") {
      // Older Pi builds never emitted agent_settled; agent_end without willRetry
      // must still complete.
      emit(header);
      emit(message);
      emit(agentEnd);
      process.exit(0);
      return;
    }
    if (mode === "wrap-up") {
      // Emits turns until it receives a wrap-up steer, then answers and settles.
      // Exercises the graceful budget-stop flow (steer + grace turns).
      emit(header);
      const turnMessage = (text, turn) => ({
        ...message,
        message: {
          ...message.message,
          content: [{ type: "text", text }],
          usage: { ...message.message.usage, cost: { ...message.message.usage.cost, total: 0.001 * turn } },
        },
      });
      let turn = 0;
      const ignoreSteer = process.env.FAKE_PI_IGNORE_STEER === "1";
      const deadline = Date.now() + Number(process.env.FAKE_PI_PAUSE_MS || 5_000);
      while (Date.now() < deadline) {
        turn++;
        if (steered.length && !ignoreSteer) {
          emit(turnMessage(`FINAL WRAP-UP after steer: ${steered[0]}`, turn));
          emit(agentEnd);
          emit(agentSettled);
          process.exit(0);
        }
        emit(turnMessage(`working on step ${turn}…`, turn));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      emit(agentEnd);
      emit(agentSettled);
      process.exit(0);
      return;
    }
    if (mode === "stall") {
      // Emits the header + one message, then goes silent forever (process alive,
      // no events). Exercises the stall watchdog. Ignores get_state probes.
      emit(header);
      emit(message);
      return; // stays alive; setInterval below keeps the loop running
    }
    if (mode === "flaky-then-success") {
      // First invocation fails with a provider error; subsequent ones succeed.
      // Coordination via a marker file (attempts are separate processes).
      const fsMod = await import("node:fs");
      const marker = process.env.FAKE_PI_FLAKY_MARKER || "/tmp/fake-pi-flaky-marker";
      if (!fsMod.existsSync(marker)) {
        fsMod.writeFileSync(marker, "1");
        emit(header);
        emit({ ...message, message: { ...message.message, stopReason: "error", errorMessage: "provider 502" } });
        emit(agentEnd);
        emit(agentSettled);
        process.exit(0);
        return;
      }
      emit(header);
      const model = process.env.FAKE_PI_REPORT_MODEL
        ? { ...message, message: { ...message.message, model: process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "fake/model" } }
        : message;
      emit(model);
      emit(agentEnd);
      emit(agentSettled);
      process.exit(0);
      return;
    }
    if (mode === "schema-good") {
      // Emits a valid fenced json:result block on the first prompt.
      emit(header);
      emit({
        ...message,
        message: { ...message.message, content: [{ type: "text", text: 'Here are my findings.\n\n```json:result\n{"files": ["a.ts"], "risk": "low"}\n```' }] },
      });
      emit(agentEnd);
      emit(agentSettled);
      // Stay alive: real RPC children wait for stdin close after settle.
      return;
    }
    if (mode === "schema-repair") {
      // First result is invalid (missing required field); the repair prompt
      // triggers a corrected block. Exercises the steer-based repair round.
      emit(header);
      emit({
        ...message,
        message: { ...message.message, content: [{ type: "text", text: '```json:result\n{"files": []}\n```' }] },
      });
      emit(agentEnd);
      emit(agentSettled);
      // Wait for the repair prompt (second prompt command), then emit valid output.
      const deadline = Date.now() + Number(process.env.FAKE_PI_PAUSE_MS || 3_000);
      while (promptCount < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (promptCount >= 2) {
        emit({
          ...message,
          message: { ...message.message, content: [{ type: "text", text: 'Corrected.\n```json:result\n{"files": ["a.ts"], "risk": "low"}\n```' }] },
        });
        emit(agentEnd);
        emit(agentSettled);
      }
      return;
    }
    if (mode === "schema-bad") {
      // Always emits invalid output, even after the repair prompt.
      emit(header);
      const bad = () => emit({
        ...message,
        message: { ...message.message, content: [{ type: "text", text: "No JSON here, just prose." }] },
      });
      bad();
      emit(agentEnd);
      emit(agentSettled);
      const deadline = Date.now() + Number(process.env.FAKE_PI_PAUSE_MS || 3_000);
      while (promptCount < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (promptCount >= 2) {
        bad();
        emit(agentEnd);
        emit(agentSettled);
      }
      return;
    }
    if (mode === "steer-echo") {
      // Emit header + first message, wait for a steer command, then echo it back
      // in a second assistant message and settle.
      emit(header);
      emit(message);
      const deadline = Date.now() + Number(process.env.FAKE_PI_PAUSE_MS || 2_000);
      while (!steered.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const text = steered[0] ?? "(no steer received)";
      emit({
        ...message,
        message: { ...message.message, content: [{ type: "text", text: `steered: ${text}` }] },
      });
      emit(agentEnd);
      emit(agentSettled);
      process.exit(0);
      return;
    }
    if (mode === "malformed") process.stdout.write("not-json\n");
    // Deliberately batch events; optionally pause after billed message usage.
    const update = { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "Hello" } };
    if (mode === "pause-after-message") {
      process.stdout.write([header, update, message].map((value) => JSON.stringify(value)).join("\n") + "\n");
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_PI_PAUSE_MS || 250)));
      emit(agentEnd);
      emit(agentSettled);
      process.exit(0);
      return;
    }
    if (mode === "partial-crash") {
      // Crash after useful assistant output but before agent_settled — partial.
      process.stdout.write([header, update, message].map((value) => JSON.stringify(value)).join("\n") + "\n");
      process.exit(1);
      return;
    }
    process.stdout.write(
      [header, update, message, agentEnd, agentSettled].map((value) => JSON.stringify(value)).join("\n") +
        (mode === "unterminated" ? "" : "\n"),
    );
    process.exit(0);
  };

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let command;
      try { command = JSON.parse(line); } catch { continue; }
      if (command.type === "prompt") {
        promptCount++;
        if (!promptSeen) {
          promptSeen = true;
          void runScript();
        }
      }
      if (command.type === "get_state" && mode !== "stall") {
        // A truly hung child answers nothing — stall mode ignores liveness probes.
        emit({ type: "response", command: "get_state", success: true, data: { sessionId: header.id, isStreaming: promptSeen } });
      }
      if (command.type === "steer") {
        steered.push(String(command.message ?? ""));
        emit({ type: "response", command: "steer", success: true });
      }
    }
  });
  process.stdin.on("end", () => {
    // Real RPC mode shuts down when stdin closes. Signal/stall modes ignore it
    // so cancellation and watchdog tests can exercise kill paths.
    if (mode !== "signal" && mode !== "stall") process.exit(0);
  });
  if (mode === "signal" || mode === "stall") setInterval(() => {}, 1000);
}

export function getFakePiCommand() {
  return { command: process.execPath, args: [filename] };
}
