import type { Message } from "@earendil-works/pi-ai";
import type { TaskResult, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { addUsage, hasBilledUsage, usageFromMessage, usageFromToolResultMessage } from "./usage.js";

export type ProtocolUpdate =
  | { type: "session"; sessionId: string }
  | { type: "live-text"; delta: string; liveText: string }
  | { type: "message"; message: Message; usage: UsageStats }
  | { type: "agent-end"; willRetry?: boolean }
  | { type: "agent-settled" }
  /** RPC extension UI dialog awaiting an answer; headless children auto-cancel. */
  | { type: "ui-request"; id: string }
  /** The child rejected the prompt; no agent events will follow. */
  | { type: "fatal"; error: string };

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
  private agentSettledSeen = false;
  private pendingRetry = false;
  private model?: string;
  private stopReason?: string;
  private errorMessage?: string;
  private transcriptLines: string[] = [];
  private transcriptBytes = 0;
  private transcriptTruncated = false;
  private transcriptJoined?: string;

  private static readonly MAX_TRANSCRIPT_BYTES = 32_768;
  /** Guard against a single unbounded JSON line exhausting parent memory. */
  private static readonly MAX_LINE_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;

  /** Append transcript lines incrementally; never re-flattens the full message list. */
  private appendTranscript(lines: string[]): void {
    for (const line of lines) {
      if (!line) continue;
      if (this.transcriptTruncated) return;
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (this.transcriptBytes + bytes > ProtocolParser.MAX_TRANSCRIPT_BYTES) {
        this.transcriptLines.push("[transcript truncated]");
        this.transcriptTruncated = true;
        this.transcriptJoined = undefined;
        return;
      }
      this.transcriptLines.push(line);
      this.transcriptBytes += bytes;
      this.transcriptJoined = undefined;
    }
  }

  private transcriptFromMessage(message: any): string[] {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return (message.content as any[]).flatMap((part) => {
        if (part?.type === "text" && part.text) return [String(part.text)];
        if (part?.type === "toolCall") return [`→ ${part.name} ${JSON.stringify(part.arguments ?? {})}`];
        return [];
      });
    }
    if (message.role === "toolResult") {
      const text = Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("")
        : "";
      return [`← ${message.toolName}${message.isError ? " [error]" : ""} ${text}`];
    }
    return [];
  }

  feed(data: Buffer | string): ProtocolUpdate[] {
    this.buffer += data.toString();
    // If a single line grows past the hard limit without a newline, drop it as a parse error.
    if (Buffer.byteLength(this.buffer, "utf8") > ProtocolParser.MAX_BUFFER_BYTES) {
      this.parseErrors++;
      this.buffer = "";
      return [];
    }
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
    if (Buffer.byteLength(trimmed, "utf8") > ProtocolParser.MAX_LINE_BYTES) {
      this.parseErrors++;
      return [];
    }
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

    // RPC-mode command responses. get_state supplies the session identity
    // (RPC mode has no print-mode session header line).
    if (event.type === "response") {
      if (event.command === "get_state" && event.success && typeof event.data?.sessionId === "string" && event.data.sessionId) {
        this.sessionId = event.data.sessionId;
        this.headerSeen = true;
        return [{ type: "session", sessionId: this.sessionId! }];
      }
      // A rejected prompt means the child will idle forever; surface it.
      if (event.success === false && (event.command === "prompt" || event.command === "parse")) {
        return [{ type: "fatal", error: String(event.error ?? "child rejected the prompt") }];
      }
      return [];
    }

    // Extension UI dialogs block the child until answered. Headless subagents
    // cannot answer; the runner replies with a cancellation.
    if (event.type === "extension_ui_request") {
      const dialog = ["select", "confirm", "input", "editor"].includes(event.method);
      return dialog && typeof event.id === "string" ? [{ type: "ui-request", id: event.id }] : [];
    }

    if (event.type === "message_update" && event.message?.role === "assistant") {
      const delta =
        typeof event.assistantMessageEvent?.delta === "string"
          ? event.assistantMessageEvent.delta
          : this.textParts(event.message).join("");
      if (!delta) return [];
      // Cap live text growth: keep the last 64KB of visible text so long runs stay bounded.
      this.liveText = (this.liveText + delta).slice(-64 * 1024);
      return [{ type: "live-text", delta, liveText: this.liveText }];
    }

    if (event.type === "message_end" && event.message) {
      const message = event.message as Message;
      this.messages.push(message);
      this.appendTranscript(this.transcriptFromMessage(message));
      if (message.role === "assistant") {
        this.assistantEndSeen = true;
        this.usage = addUsage(this.usage, usageFromMessage(message));
        this.model ||= message.model;
        this.stopReason = message.stopReason;
        this.errorMessage = message.errorMessage;
        const text = this.textParts(message).join("");
        if (text) this.liveText = text;
      } else if (message.role === "toolResult") {
        // Pi ≥ #6671: tool results may carry nested LLM usage (e.g. a
        // grandchild subagent). Fold it into the run's cumulative spend so
        // budgets and parent ledgers see true subtree cost.
        const nested = usageFromToolResultMessage(message);
        if (hasBilledUsage(nested)) this.usage = addUsage(this.usage, nested);
      }
      return [{ type: "message", message, usage: { ...this.usage } }];
    }

    if (event.type === "agent_end") {
      this.agentEndSeen = true;
      // Pi may retry after agent_end (willRetry: true). That is NOT terminal;
      // only agent_settled marks a fully settled run.
      const willRetry = event.willRetry === true;
      this.pendingRetry = willRetry;
      return [{ type: "agent-end", willRetry }];
    }

    if (event.type === "agent_settled") {
      this.agentSettledSeen = true;
      this.pendingRetry = false;
      return [{ type: "agent-settled" }];
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
      agentSettledSeen: this.agentSettledSeen,
      validEvents: this.validEvents,
      parseErrors: this.parseErrors,
    };
    // Prefer agent_settled as the true terminal watermark. Fall back to
    // agent_end without a pending retry for older Pi builds that never emitted
    // agent_settled (json print historically closed after agent_end).
    const settled = this.agentSettledSeen || (this.agentEndSeen && !this.pendingRetry);
    const completeProtocol = this.headerSeen && this.assistantEndSeen && settled;
    const assistantFailed = this.stopReason === "error" || this.stopReason === "aborted";
    const successfulExit = exitCode === 0 && !signal && !assistantFailed;
    // Preserve partial paid work when the process crashed (signal/nonzero) AFTER
    // producing assistant output but BEFORE a complete terminal protocol. A
    // complete protocol that still exits nonzero remains "failed".
    const hasUsefulOutput = this.assistantEndSeen && (this.liveText.length > 0 || this.usage.turns > 0);
    let state: TaskResult["state"];
    if (successfulExit && completeProtocol) {
      state = "completed";
    } else if (hasUsefulOutput && !assistantFailed && !completeProtocol) {
      state = "partial";
    } else if (hasUsefulOutput && !assistantFailed && signal) {
      // Complete protocol but killed by signal (e.g. parent shutdown): partial.
      state = "partial";
    } else {
      state = "failed";
    }
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
      exitCode: exitCode === 0 && state === "failed" ? 1 : exitCode,
      signal,
      messages: [...this.messages],
      stderr,
      usage: { ...this.usage },
      model: this.model,
      stopReason,
      errorMessage:
        this.errorMessage ||
        (signal ? `Subagent terminated unexpectedly by ${signal}` : undefined) ||
        (exitCode !== 0 ? `Subagent exited with code ${exitCode}` : undefined) ||
        (state === "partial" && !completeProtocol
          ? "Protocol stream truncated; partial output preserved"
          : undefined),
      liveText: this.liveText || undefined,
      transcript: this.getTranscript(),
      protocol,
      sessionId: this.sessionId,
    };
  }

  /** Cached join; safe to call on every progress tick. */
  getTranscript(): string | undefined {
    if (this.transcriptJoined === undefined) this.transcriptJoined = this.transcriptLines.join("\n");
    return this.transcriptJoined || undefined;
  }

  getLiveText(): string {
    return this.liveText;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }
}
