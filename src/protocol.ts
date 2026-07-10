import type { Message } from "@earendil-works/pi-ai";
import type { TaskResult, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { addUsage, usageFromMessage } from "./usage.js";

export type ProtocolUpdate =
  | { type: "session"; sessionId: string }
  | { type: "live-text"; delta: string; liveText: string }
  | { type: "message"; message: Message; usage: UsageStats }
  | { type: "agent-end" };

/** Strict-enough, line-buffered parser for Pi's documented JSON event stream. */
export class ProtocolParser {
  private buffer = "";
  private sessionId?: string;
  private messages: Message[] = [];
  private usage = emptyUsage();
  private liveText = "";
  private parseErrors = 0;
  private validEvents = 0;
  private headerSeen = false;
  private assistantEndSeen = false;
  private agentEndSeen = false;
  private model?: string;
  private stopReason?: string;
  private errorMessage?: string;

  feed(data: Buffer | string): ProtocolUpdate[] {
    this.buffer += data.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  /** Parse a final JSON object even when stdout omitted its trailing newline. */
  flush(): ProtocolUpdate[] {
    if (!this.buffer.trim()) return [];
    const line = this.buffer;
    this.buffer = "";
    return this.parseLine(line);
  }

  private parseLine(line: string): ProtocolUpdate[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.parseErrors++;
      return [];
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.parseErrors++;
      return [];
    }
    this.validEvents++;

    if (event.type === "session") {
      if (typeof event.id !== "string" || !event.id) {
        this.parseErrors++;
        return [];
      }
      this.sessionId = event.id;
      this.headerSeen = true;
      return [{ type: "session", sessionId: event.id }];
    }

    if (event.type === "message_update" && event.message?.role === "assistant") {
      const delta =
        typeof event.assistantMessageEvent?.delta === "string"
          ? event.assistantMessageEvent.delta
          : this.textParts(event.message).join("");
      if (!delta) return [];
      this.liveText += delta;
      return [{ type: "live-text", delta, liveText: this.liveText }];
    }

    if (event.type === "message_end" && event.message) {
      const message = event.message as Message;
      this.messages.push(message);
      if (message.role === "assistant") {
        this.assistantEndSeen = true;
        this.usage = addUsage(this.usage, usageFromMessage(message));
        this.model ||= message.model;
        this.stopReason = message.stopReason;
        this.errorMessage = message.errorMessage;
        const text = this.textParts(message).join("");
        if (text) this.liveText = text;
      }
      return [{ type: "message", message, usage: { ...this.usage } }];
    }

    if (event.type === "agent_end") {
      this.agentEndSeen = true;
      return [{ type: "agent-end" }];
    }

    // Other documented event types are valid but do not affect this projection.
    return [];
  }

  private textParts(message: any): string[] {
    if (!Array.isArray(message?.content)) return [];
    return message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text);
  }

  finalize(exitCode: number | null, signal?: NodeJS.Signals, stderr = ""): TaskResult {
    this.flush();
    const protocol = {
      headerSeen: this.headerSeen,
      assistantEndSeen: this.assistantEndSeen,
      agentEndSeen: this.agentEndSeen,
      validEvents: this.validEvents,
      parseErrors: this.parseErrors,
    };
    const completeProtocol = this.headerSeen && this.assistantEndSeen && this.agentEndSeen;
    const assistantFailed = this.stopReason === "error" || this.stopReason === "aborted";
    const successfulExit = exitCode === 0 && !signal && !assistantFailed;
    const state = successfulExit && completeProtocol ? "completed" : "failed";
    const stopReason = signal
      ? "unexpected_signal"
      : exitCode !== 0
        ? "nonzero_exit"
        : !completeProtocol
          ? "protocol_error"
          : assistantFailed
            ? this.stopReason!
            : this.stopReason || "stop";
    return {
      label: "subagent",
      task: "",
      state,
      exitCode: exitCode === 0 && !completeProtocol ? 1 : exitCode,
      signal,
      messages: [...this.messages],
      stderr,
      usage: { ...this.usage },
      model: this.model,
      stopReason,
      errorMessage:
        this.errorMessage ||
        (signal ? `Subagent terminated unexpectedly by ${signal}` : undefined) ||
        (exitCode !== 0 ? `Subagent exited with code ${exitCode}` : undefined),
      liveText: this.liveText || undefined,
      protocol,
      sessionId: this.sessionId,
    };
  }

  getLiveText(): string {
    return this.liveText;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }
}
