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
 * Discriminated by `action` when present; otherwise single or parallel task request.
 * Management actions cannot carry task payloads.
 */
export const SubagentParamsSchema = Type.Union(
  [
    Type.Object(
      {
        action: Type.Literal("status"),
        id: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal("wait"),
        id: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal("cancel"),
        id: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        task: Type.String({ minLength: 1, description: "Task to delegate (single mode)." }),
        ...TaskFields,
        async: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        tasks: Type.Array(ParallelTaskItem, {
          minItems: 1,
          maxItems: 8,
          description: "Array of independent tasks for parallel mode.",
        }),
        async: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "Subagent request: single, parallel, status, wait, or cancel." },
);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type ParallelTaskInput = Static<typeof ParallelTaskItem>;
