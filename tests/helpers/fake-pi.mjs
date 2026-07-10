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

if (isMain) {
  const mode = process.env.FAKE_PI_MODE || "success";
  const delay = Number(process.env.FAKE_PI_DELAY_MS || 0);
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk.toString(); });
  process.stdin.on("end", async () => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const emit = (value, newline = true) => process.stdout.write(JSON.stringify(value) + (newline ? "\n" : ""));
    if (mode === "signal") return void setInterval(() => {}, 1000);
    if (mode === "error") { process.stderr.write("Some stderr\n"); process.exit(1); return; }
    if (mode === "incomplete") { emit(header); process.exit(0); return; }
    if (mode === "nonzero-complete") { emit(header); emit(message); emit(agentEnd); process.exit(1); return; }
    if (mode === "provider-error") {
      emit(header);
      emit({ ...message, message: { ...message.message, stopReason: "error", errorMessage: "provider failed" } });
      emit(agentEnd);
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
    } else {
      process.stdout.write([header, update, message, agentEnd].map((value) => JSON.stringify(value)).join("\n") + (mode === "unterminated" ? "" : "\n"));
    }
    void input;
    process.exit(0);
  });
}

export function getFakePiCommand() {
  return { command: process.execPath, args: [filename] };
}
