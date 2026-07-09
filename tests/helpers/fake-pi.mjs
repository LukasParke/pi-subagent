#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] === __filename || process.argv[1]?.endsWith("fake-pi.mjs");

const RESPONSES = {
  success: {
    header: { type: "session", id: "test-session-123" },
    updates: [
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: " world!" }] },
      },
    ],
    end: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " world!" },
        ],
        model: "fake/model",
        stopReason: "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.001 },
          totalTokens: 15,
        },
      },
    },
    agentEnd: { type: "agent_end" },
  },
};

if (isMain) {
  const mode = process.env.FAKE_PI_MODE || "success";
  const delayMs = Number(process.env.FAKE_PI_DELAY_MS || "0");

  let stdin = "";
  process.stdin.on("data", (c) => {
    stdin += c.toString();
  });

  process.stdin.on("end", async () => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

    if (mode === "error") {
      process.stderr.write("Some stderr\n");
      process.exit(1);
    }

    if (mode === "signal") {
      // Stay alive until killed
      setInterval(() => {}, 1000);
      return;
    }

    if (mode === "incomplete") {
      // session header only — no assistant message_end
      emit({ type: "session", id: "incomplete-456" });
      process.exit(0);
      return;
    }

    if (mode === "malformed") {
      process.stdout.write("not json\n");
      emit(RESPONSES.success.header);
      process.stdout.write("invalid json {\n");
      emit(RESPONSES.success.updates[0]);
      emit(RESPONSES.success.end);
      emit(RESPONSES.success.agentEnd);
      process.exit(0);
      return;
    }

    // success (default)
    void stdin;
    emit(RESPONSES.success.header);
    for (const u of RESPONSES.success.updates) emit(u);
    emit(RESPONSES.success.end);
    emit(RESPONSES.success.agentEnd);
    process.exit(0);
  });
}

export function getFakePiCommand() {
  return {
    command: process.execPath,
    args: [__filename],
  };
}
