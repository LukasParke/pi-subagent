import { Type, type Static } from "typebox";

const ThinkingLevel = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

const OutputMode = Type.Union([Type.Literal("inline"), Type.Literal("file-only")]);
const Profile = Type.Union([Type.Literal("explore"), Type.Literal("review"), Type.Literal("general")]);
const Isolation = Type.Union([Type.Literal("shared"), Type.Literal("worktree")]);
const Action = Type.Union([
  Type.Literal("status"),
  Type.Literal("wait"),
  Type.Literal("cancel"),
]);

/** Shared optional task configuration fields. */
export const TaskFields = {
  system_prompt: Type.Optional(Type.String({ description: "Optional extra system prompt for the child." })),
  model: Type.Optional(Type.String({ description: "Model id, e.g. anthropic/claude-haiku-4.5" })),
  thinking: Type.Optional(ThinkingLevel),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist." })),
  profile: Type.Optional(Profile),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child process." })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 60 * 60_000 })),
  max_turns: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  max_cost: Type.Optional(Type.Number({ minimum: 0 })),
  output: Type.Optional(Type.String({ description: "File path to write final output." })),
  output_mode: Type.Optional(OutputMode),
  resume: Type.Optional(Type.String({ description: "Child session id to continue." })),
  fork_resume: Type.Optional(Type.Boolean({ description: "Fork the resumed session instead of direct resume." })),
  isolation: Type.Optional(Isolation),
  allow_shared_writes: Type.Optional(
    Type.Boolean({ description: "Unsafe opt-in for parallel writers sharing one checkout." }),
  ),
} as const;

export const ParallelTaskItem = Type.Object(
  {
    task: Type.String({ minLength: 1, description: "Task text for one parallel worker." }),
    ...TaskFields,
  },
  { additionalProperties: false },
);

/**
 * Provider-facing tool parameters.
 *
 * IMPORTANT: LLM tool APIs (OpenAI-compatible / OpenRouter / Anthropic via many
 * providers) require the top-level parameters schema to be JSON Schema
 * `type: "object"`. A Type.Union serializes as `anyOf` without `type: "object"`,
 * which surfaces as:
 *   Invalid schema for function 'subagent': schema must be a JSON Schema of
 *   'type: "object"', got 'type: "None"'.
 *
 * Mode exclusivity (action vs task vs tasks) is enforced in policy validation,
 * not at the JSON Schema layer.
 */
export const SubagentParamsSchema = Type.Object(
  {
    // Management actions
    action: Type.Optional(Action),
    id: Type.Optional(Type.String({ minLength: 1, description: "Run id for status/wait/cancel." })),

    // Single-task mode
    task: Type.Optional(Type.String({ minLength: 1, description: "Task to delegate (single mode)." })),
    ...TaskFields,
    async: Type.Optional(Type.Boolean({ description: "Run in the background and return a handle immediately." })),

    // Parallel mode
    tasks: Type.Optional(
      Type.Array(ParallelTaskItem, {
        minItems: 1,
        maxItems: 8,
        description: "Array of independent tasks for parallel mode.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Subagent request: single, parallel, status, wait, or cancel.",
  },
);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type ParallelTaskInput = Static<typeof ParallelTaskItem>;

/** Runtime guard used by tests/docs to assert provider compatibility. */
export function assertObjectToolSchema(schema: unknown): asserts schema is { type: "object" } {
  if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") {
    const type = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : typeof schema;
    throw new Error(`Tool parameters must be JSON Schema type "object", got ${JSON.stringify(type ?? "None")}`);
  }
}
