# pi-subagent

Production-grade isolated subagents for [Pi](https://github.com/badlogic/pi-mono).

Delegate research, parallel exploration, and clean-context review to child Pi
processes. Named agent personas, cancellable background runs with completion
notifications and a live widget, mid-run steering, graceful budget wrap-ups,
automatic retry with model fallback, a stall watchdog, session resume and
context forking, worktree isolation with a diff/apply/discard loop, capability
profiles, a root/subagent/combined cost ledger, and a TUI inspector.

## Install

Pi packages install from **npm**, **git**, or a **local path**:

```bash
# npm (scoped; surfaces on the pi.dev gallery via the pi-package keyword)
# Note: unscoped "pi-subagent" is rejected by npm as too similar to "pi-sub-agent".
pi install npm:@lukehagar/pi-subagent@0.2.0

# latest npm
pi install npm:@lukehagar/pi-subagent

# git pin to a release tag
pi install git:github.com/LukasParke/pi-subagent@v0.2.0

# live main
pi install git:github.com/LukasParke/pi-subagent

# local checkout
pi install /absolute/path/to/pi-subagent
```

Then start Pi normally. The package registers:

- tool: `subagent`
- command: `/subagents` (run inspector overlay)
- command: `/subagent-cost` (parent / subagent / combined usage on demand)

Publishing is automated from `v*` tags — see [docs/RELEASING.md](./docs/RELEASING.md).

## Quick usage

```ts
// Single foreground task
{ task: "Find all call sites of parseConfig and summarize patterns.", description: "Map parseConfig usage" }

// Named agent — persona prompt + defaults from .pi/agents/reviewer.md.
// Explicit params still override any agent field.
{ task: "Review this diff for security issues", agent: "reviewer" }

// Parallel read-only explorers (default profile: explore)
{
  tasks: [
    { task: "Map auth middleware flow", description: "Auth flow map" },
    { task: "List all env vars used in server/", description: "Env var inventory" }
  ]
}

// Parallel research with automatic fan-in: one read-only child folds all
// outputs into a single brief, delivered first.
{
  tasks: [
    { task: "Audit backend error handling", description: "Backend audit" },
    { task: "Audit frontend error handling", description: "Frontend audit" }
  ],
  synthesis: "Merge both audits into one prioritized findings list"
}

// Background run — you are notified on completion (batched followUp message),
// a live widget tracks progress above the editor, and wait/status still work.
{ task: "Audit dependency licenses", async: true }
// later
{ action: "status", id: "abc123" }
{ action: "wait", id: "abc123" }      // interruptible; does not cancel
{ action: "cancel", id: "abc123" }

// Fork the parent conversation into the child (needs a persisted session).
// The child starts from a branched copy of everything discussed so far.
{ task: "Implement the plan we agreed on", context: "fork", profile: "general" }

// Budgets with graceful wrap-up: at the limit the child is steered to produce
// a final answer and given grace turns before any hard stop.
{ task: "Audit deps", max_turns: 15, grace_turns: 2 }

// Automatic retry with model fallback on transient failures
// (provider errors, stalls, queue timeouts — never task-quality failures).
{ task: "Research X", model: "openrouter/model-a", fallback_models: ["openrouter/model-b"], max_retries: 1 }

// Steer a running child mid-run instead of cancel + retry. The message is
// delivered after the current assistant turn, before the next LLM call.
{ action: "steer", id: "abc123", message: "Skip the tests directory; focus on src/" }
// Parallel runs: pass index to pick one live task.
{ action: "steer", id: "abc123", index: 1, message: "Wrap up now" }

// Resume a child session
{ task: "Continue from your findings and propose a fix plan", resume: "<session-id>" }

// Isolated writers
{
  tasks: [
    { task: "Implement feature A", profile: "general", isolation: "worktree" },
    { task: "Implement feature B", profile: "general", isolation: "worktree" }
  ]
}

// Close the worktree loop after the run finishes:
{ action: "diff", id: "abc123", index: 0 }     // inspect the patch
{ action: "apply", id: "abc123", index: 0 }    // land as uncommitted changes in your checkout
{ action: "discard", id: "abc123", index: 1 }  // drop worktree + branch
```

The `/subagents` overlay mirrors the worktree loop interactively: `s` steer,
`a` apply, `x` discard on the selected run.

## Profiles

| Profile | Tools | Writes |
|---------|-------|--------|
| `explore` (parallel default) | read/grep/find/ls + safe extras | no |
| `review` | same as explore | no |
| `general` | inherited active tools | yes if tools include bash/edit/write |

Parallel write-capable tasks sharing one checkout are rejected unless each uses
`isolation: "worktree"`, distinct `cwd`, or explicit `allow_shared_writes: true`.

## Configuration

Defaults can be overridden in `~/.pi/subagent.json` and per-field via env vars
(env wins over file):

| Setting | Env var | Default |
|---------|---------|---------|
| `maxTasksPerRun` | `PI_SUBAGENT_MAX_TASKS` | 8 |
| `maxActiveProcesses` | `PI_SUBAGENT_MAX_ACTIVE` | 4 |
| `maxQueuedTasks` | `PI_SUBAGENT_MAX_QUEUED` | 32 |
| `maxGlobalActive` | `PI_SUBAGENT_MAX_GLOBAL_ACTIVE` | 16 |
| `defaultTimeoutMs` | `PI_SUBAGENT_TIMEOUT_MS` | 900000 |
| `maxDepth` | `PI_SUBAGENT_MAX_DEPTH` | 2 |
| `killGraceMs` | `PI_SUBAGENT_KILL_GRACE_MS` | 3000 |
| `sessionDir` | `PI_SUBAGENT_SESSION_DIR` | `~/.pi/subagent-sessions` |
| `worktreeDir` | `PI_SUBAGENT_WORKTREE_DIR` | `~/.pi/subagent-worktrees` |
| `lockDir` | `PI_SUBAGENT_LOCK_DIR` | `~/.pi/subagent-locks` |
| `worktreeRetentionDays` | `PI_SUBAGENT_WORKTREE_RETENTION_DAYS` | 7 |
| `sessionRetentionDays` | `PI_SUBAGENT_SESSION_RETENTION_DAYS` | off |
| `lockRetentionDays` | `PI_SUBAGENT_LOCK_RETENTION_DAYS` | 7 |
| `taskDefaults` | — | none |
| `graceTurns` | `PI_SUBAGENT_GRACE_TURNS` | 2 |
| `stallAfterMs` | `PI_SUBAGENT_STALL_AFTER_MS` | 90000 |
| `stallKillAfterMs` | `PI_SUBAGENT_STALL_KILL_AFTER_MS` | 90000 |
| `maxRetries` | `PI_SUBAGENT_MAX_RETRIES` | 1 |
| (bin) | `PI_SUBAGENT_BIN` | auto (`process.execPath` + CLI entry) |

### Named agent files

Define reusable subagent personas as markdown files, discovered from the same
conventional roots skills use (higher root wins name conflicts):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 | `.pi/agents/<name>.md` | project (authoritative) |
| 2 | `.agents/agents/<name>.md` | shared cross-tool workspace |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`) | global |

The markdown body becomes the child's appended system prompt; frontmatter
supplies defaults using the same snake_case names as the tool parameters:

```md
---
description: Security-focused code reviewer
model: openrouter/x-ai/grok-4.5
thinking: high
profile: review
max_turns: 20
fallback_models: [openrouter/backup-model]
---

You are a security auditor. Review code for injection flaws, auth issues,
and sensitive data exposure. Report findings with file:line evidence and
severity ratings.
```

Invoke with `{ task: "…", agent: "reviewer" }`. Precedence per field:
**explicit request params > agent file > per-profile `taskDefaults` > parent
inheritance**. An explicit `system_prompt` appends after the persona body.
Profiles still enforce capability: an agent declaring `profile: review` with
write tools fails closed. The agent catalog is advertised in the tool's
system-prompt guidelines (session start) and in bare `status` output (live),
and file changes are picked up within seconds — no restart needed.

### Per-profile task defaults

`taskDefaults` in `~/.pi/subagent.json` supplies model/thinking/budget defaults
per capability profile. Explicit request values always win; profile defaults
beat parent-session inheritance. This is how you route all exploration to a
cheap model without naming agents:

```json
{
  "taskDefaults": {
    "explore": { "model": "openrouter/moonshotai/kimi-k2.6", "thinking": "medium", "maxTurns": 15, "maxCost": 0.25 },
    "review":  { "model": "openrouter/moonshotai/kimi-k2.6", "thinking": "medium" },
    "general": { "model": "openrouter/x-ai/grok-4.5", "thinking": "medium" }
  }
}
```

Each profile accepts `model`, `thinking`, `maxTurns`, `maxCost`, `timeoutMs`,
`fallbackModels`, and `maxRetries`. Invalid fields are dropped field-by-field.

Notes on behavior:

- `timeout_ms` covers queue time plus runtime, but timed-out tasks report
  `state: "timeout"` with `timeoutPhase: "queued"|"starting"|"running"` so
  agents can retry capacity issues without confusing them for task failures.
- Budget stops (`max_turns`, `max_cost`) trigger a **graceful wrap-up**: the
  child is steered to produce its final answer NOW and allowed `graceTurns`
  more turns before SIGTERM. Results end as `partial` with `wrappedUp: true`
  when the child concluded in time. `graceTurns: 0` restores immediate stops.
- A **stall watchdog** flags children with no protocol activity for
  `stallAfterMs` (a liveness probe distinguishes quiet-but-thinking from dead),
  then kills after `stallKillAfterMs` more silence — feeding automatic retry
  instead of burning the whole timeout.
- **Transient failures retry automatically** (queue timeouts, stalls, spawn
  errors, provider errors) up to `maxRetries` extra attempts, escalating
  through `fallback_models` when provided. Usage accumulates across attempts;
  results record `attempts` and `attemptedModels`. Task-quality failures
  (nonzero exit with complete protocol, cancellations, budget stops, running
  timeouts) never retry.
- `context: "fork"` starts a single child from a real branched copy of the
  parent conversation (`--fork` on the parent's session file). It requires a
  persisted parent session, cannot combine with `resume`, and is rejected for
  parallel fanout (context duplication × N is a cost bug, not a feature).
  Protocol streams truncated after useful assistant output also end as `partial`.
- Aborting a `wait` returns immediately without cancelling the background run.
- Child processes are launched via the same Node runtime + CLI entry as the
  parent when possible (`PI_SUBAGENT_BIN` overrides). Bare `pi` on PATH is only
  a logged last resort.
- Direct resume is exclusive **across processes** via durable locks under
  `lockDir`. Lost runs block resume until startup orphan reconciliation kills
  (or confirms dead) the recorded child process group.
- `maxGlobalActive` bounds concurrent children across every Pi parent process
  on the machine (in addition to the per-session semaphore).
- Nested children at the depth ceiling do not re-register the subagent tool;
  only top-level parents run maintenance/orphan reclaim/worktree GC.
- Preserved worktrees live under `worktreeDir` (durable, not `/tmp`) and are
  garbage-collected on startup: unchanged leftovers immediately, changed ones
  after `worktreeRetentionDays`. Live runs are never swept.
- `keep_background: true` on a task keeps processes the child intentionally
  backgrounded (e.g. dev servers) alive after a clean exit.

## Design invariants

1. A run belongs to one parent session and cannot update another session.
2. Per-session + machine-wide process caps and nesting depth limits prevent process storms.
3. Cancellation prevents queued tasks from spawning.
4. Direct resume of a child session is exclusive **across processes** via durable locks.
5. Tool responses are capped to ~50KB/2000 lines; full output lives in
   artifacts and `~/.pi/subagent-sessions`.
6. Status is compact; wait is the one-shot deliverable.
7. On parent session shutdown, live children are aborted and awaited briefly.
8. On parent (re)start, orphan process groups recorded under `lockDir` are reaped
   before any resume is allowed for the matching child session.
9. Provider-reported usage is counted once per root message and terminal child run.
10. Protocol completion prefers `agent_settled` (falls back to non-retrying `agent_end`).

## Layout

```
src/
  extension.ts     # Pi wiring only
  schema.ts        # request schema
  policy.ts        # profiles, normalization, write guards, agent resolution
  agents.ts        # named agent files (.pi/agents/, .agents/agents/, global)
  launch.ts        # resolve child pi via execPath / PI_SUBAGENT_BIN
  process-lock.ts  # durable session locks, global slots, orphan records
  worktree.ts      # git worktree isolation + diff/apply/discard
  orchestrator.ts  # multi-task execution, transient retry + model fallback
  runner.ts        # child process lifecycle, RPC channel, steering,
                   # graceful budget wrap-up, stall watchdog
  protocol.ts      # Pi RPC/JSON event parser (agent_settled-aware)
  semaphore.ts     # per-session concurrency limit
  registry.ts      # session-scoped run state + durable resume locks
  persistence.ts   # parent-session event folding
  usage.ts         # root/subagent/combined usage ledger
  output.ts        # exact global output caps
  notifications.ts # batched background-run completion notifications
  format.ts / ui.ts# renderers, ambient widget, /subagents overlay
```

## Develop

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

Tests use a deterministic `fake-pi` child. No live model calls are required.

## Cost accounting

`status`, `/subagent-cost`, and the `/subagents` overlay header show separate
**root**, **subagent**, and **combined** totals based on provider-reported
usage. The footer stays terse (running/ready counts only) because Pi's native
footer already reports session cost. Delivery and replay do not double count
runs. See [docs/COST-ACCOUNTING.md](./docs/COST-ACCOUNTING.md).

## Security

See [docs/SECURITY.md](./docs/SECURITY.md). Pi packages run with full system
access—review source before installing third-party packages.

## Status

v0.1 focuses on the correct lifecycle engine:

- process + session ownership
- budgets, caps, profiles
- persistence + inspector
- worktree isolation helpers

Named agent catalogs and automatic chain workflows are intentionally deferred
until the core is battle-tested.
