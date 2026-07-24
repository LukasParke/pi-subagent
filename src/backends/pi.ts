/**
 * Pi backend — the original and default. Spawns `pi --mode rpc` and speaks
 * Pi's documented JSON event stream over stdio.
 *
 * This is a straight extraction of the logic that lived inline in
 * `ChildRunner.run()`; behavior is unchanged. It is the only backend that
 * supports every capability, because the protocol was designed for it.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BackendAdapter, BackendCapabilities, BackendInvocation, BackendLaunchContext, BackendParser } from "../backend.js";
import { ProtocolParser } from "../protocol.js";
import { schemaContract } from "../structured.js";
import type { TaskSpec } from "../types.js";

const PI_CAPABILITIES: BackendCapabilities = {
  steer: true,
  gracefulWrapUp: true,
  costReporting: true,
  resume: true,
  fork: true,
  toolRestriction: true,
  thinking: true,
  outputSchema: true,
};

export class PiBackend implements BackendAdapter {
  readonly name = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;

  async buildInvocation(spec: TaskSpec, context: BackendLaunchContext): Promise<BackendInvocation> {
    // RPC mode keeps a live stdin command channel so steering messages can be
    // injected mid-run. The event stream on stdout is a superset of json mode.
    const args = ["--mode", "rpc", "--session-dir", context.sessionDir];
    if (spec.forkResume && spec.resume) args.push("--fork", spec.resume);
    else if (spec.resume) args.push("--session", spec.resume);
    else if (spec.contextFork) {
      // Context fork: the child starts from a real branched copy of the
      // parent conversation, then receives the task as its next prompt.
      // Fail fast rather than silently degrading to a fresh session.
      if (!spec.parentSessionFile) {
        throw new Error("context:'fork' requires a persisted parent session (none available). Save the session or use context:'fresh'.");
      }
      await fs.access(spec.parentSessionFile).catch(() => {
        throw new Error(`context:'fork' failed: parent session file ${spec.parentSessionFile} is not readable.`);
      });
      args.push("--fork", spec.parentSessionFile);
    }
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    if (spec.tools !== undefined) {
      const tools = spec.tools.filter((tool) => tool !== "subagent");
      if (tools.length === 0) args.push("--no-tools");
      else args.push("--tools", tools.join(","));
    }
    // Persona/system prompt first, structured-output contract last (highest salience).
    const appendPrompt = [spec.systemPrompt?.trim(), spec.outputSchema ? schemaContract(spec.outputSchema) : undefined]
      .filter(Boolean)
      .join("\n\n");
    const cleanupDirs: string[] = [];
    if (appendPrompt) {
      const tempPromptDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
      cleanupDirs.push(tempPromptDir);
      const promptPath = path.join(tempPromptDir, "system-prompt.md");
      await fs.writeFile(promptPath, appendPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptPath);
    }

    const invocation = context.getPiCommand(args);
    return { command: invocation.command, args: invocation.args, cleanupDirs };
  }

  createParser(): BackendParser {
    return new ProtocolParser();
  }

  steerCommand(message: string): unknown {
    return { type: "steer", message };
  }

  promptCommand(message: string): unknown {
    return { type: "prompt", message };
  }

  uiCancelCommand(id: string): unknown {
    return { type: "extension_ui_response", id, cancelled: true };
  }

  stateCommand(): unknown {
    return { type: "get_state" };
  }
}
