# Changelog

## 0.2.1

- **Package moved to `@parke.dev/pi-subagent`** (owned by the `parke.dev` npm
  org). `@lukehagar/pi-subagent` is deprecated at 0.2.0 and will receive no
  further updates; install the new scope with
  `pi install npm:@parke.dev/pi-subagent`. No code changes besides the rename.
- CI/release workflows on actions/checkout@v7 + actions/setup-node@v7;
  CI matrix trimmed to supported LTS lines (22, 24); `engines.node` corrected
  to `>=22.19.0` (the actual pi-coding-agent floor).

## 0.2.0

Major feature release: reliability engine, named agents, background-run UX,
and a complete TUI overhaul.

### Named agent files

- Reusable subagent personas as markdown files with YAML frontmatter, discovered
  from `.pi/agents/` (project), `.agents/agents/` (shared workspace), and
  `$PI_CODING_AGENT_DIR/agents/` (global). Invoke with `agent: "name"`.
- Body becomes the child's appended system prompt; frontmatter supplies defaults
  (`model`, `thinking`, `profile`, `tools`, budgets, `fallback_models`, `isolation`).
- Precedence per field: explicit params > agent file > per-profile `taskDefaults`
  > parent inheritance. Capability profiles fail closed regardless of what an
  agent file declares.
- Catalog advertised in the tool's system-prompt guidelines and live in bare
  `status` output; file changes picked up within seconds.

### Reliability

- **Graceful budget stops**: at `max_turns`/`max_cost` the child is steered to
  wrap up and given `grace_turns` (default 2) for a final answer before SIGTERM.
  Results end `partial` with `wrappedUp: true` when the child concluded in time.
- **Retry with model fallback**: transient failures (queue timeouts, stalls,
  spawn errors, provider errors, protocol truncation) retry automatically up to
  `max_retries` extra attempts, escalating through `fallback_models`. Usage
  accumulates across attempts; `attempts`/`attemptedModels` recorded. Task-quality
  failures never retry.
- **Stall watchdog**: protocol silence for `stallAfterMs` (90s) flags the task
  and probes liveness via `get_state`; continued silence for `stallKillAfterMs`
  more kills the child (feeding retry) instead of burning the whole timeout.
- **PID-reuse protection on macOS/BSD**: process start-time identity via
  `ps -o lstart=`; group kills verify identity before signalling.

### Orchestration

- **Mid-run steering** (`action: "steer"`): children run in Pi RPC mode with a
  live stdin command channel; inject guidance delivered after the current turn.
- **Context forking** (`context: "fork"`): child starts from a real branched
  copy of the parent conversation. Single-task only; fails fast when the parent
  session is not persisted.
- **Worktree loop**: `diff` / `apply` / `discard` actions on finished runs with
  changed worktrees. `apply` lands the combined patch as uncommitted changes via
  `git apply --3way`; never commits, never auto-deletes.
- **Parallel synthesis** (`synthesis: "…"`): one read-only child folds parallel
  outputs into a brief delivered first, with explicit truncation markers.
- **Per-task `description`** labels and per-profile `taskDefaults` config
  (model/thinking/budget routing without naming agents).

### Background runs

- **Completion notifications**: terminal async runs send a batched `followUp`
  message so the parent reacts without polling. Successes group within a short
  window; failures flush immediately; a consuming `wait` suppresses the
  redundant notification. Themed compact box for humans.
- **Ambient widget**: live above-editor tree (spinner, stats, activity tail)
  for background runs only — foreground runs already render inline.

### TUI overhaul

- One-line `renderCall`; fixed-shape mutate-in-place streaming blocks; compact
  terminal stats with state glyphs; per-task rows for parallel runs; frozen
  durations at `endedAt`; reliability annotations (`[attempt 2]`,
  `[stalled 2m]`, `◐ wrapped up`).
- Terse footer (running/ready counts only); cost ledger moved to
  `/subagent-cost`, `status`, and the `/subagents` overlay header.
- Overlay rebuilt: themed header with counters + ledger, two-line list rows,
  structured detail view, steering (`s`), worktree apply/discard (`a`/`x`).
- Trailing-edge streaming flush (the last update of a burst always renders);
  stable component identity across partial renders.

### Performance

- Transcript joins only on message boundaries (was O(N²) per stdout chunk).
- Memoized per-result snapshot projection (only changed tasks re-project).
- Trailing-edge coalescing for streamed tool updates.

### Fixes

- Resolve the Pi CLI entry through bin symlinks (npm/Homebrew shims) instead of
  falling back to bare `pi` on PATH.
- Headless children auto-cancel extension UI dialogs so they can never hang.
- Prompt-rejection in RPC mode fails fast instead of idling forever.

## 0.1.3

- Require `type: object` tool schema for provider compatibility.

## 0.1.2

- Publish scoped `@lukehagar/pi-subagent` on npm; release workflow hardening.
