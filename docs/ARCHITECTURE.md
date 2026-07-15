# Architecture contract

`pi-subagent` is split by ownership boundary:

- `runner.ts`: one child process, Pi RPC protocol (JSONL commands on stdin, events on
  stdout — a superset of `--mode json`), cancellation, process trees, budgets, and a live
  stdin command channel used for mid-run steering. Extension UI dialogs from headless
  children are auto-cancelled so they can never hang a run; stdin is closed after
  `agent_settled` so RPC children shut down cleanly. Budget breaches steer a wrap-up
  message and allow grace turns before SIGTERM (`wrappedUp` marks a clean conclusion).
  A stall watchdog flags protocol silence, probes liveness via `get_state`, and kills
  after a second window so retry can take over. Group kills verify process start-time
  identity (Linux `/proc`, macOS/BSD `ps lstart`) before signalling a possibly-recycled
  PID; transcript joins happen only on message boundaries, not per-chunk ticks.
- Retry with model fallback lives in `orchestrator.ts` (`isTransientFailure`): queue
  timeouts, stalls, spawn errors, and provider errors re-run the same spec on the next
  fallback model with accumulated usage; task-quality failures never retry.
- `context: "fork"` spawns the child with `--fork <parent session file>` so it starts
  from a real branched copy of the parent conversation. Fail-fast when the parent
  session is not persisted; single-task only.
- `registry.ts`: one parent-session runtime, run state, snapshots, resume locks, and the
  single LiveRun→snapshot/persisted-result projections used by every consumer.
- `semaphore.ts`: per-parent-runtime child-process limit.
- `process-lock.ts`: machine-wide durable coordination under `~/.pi/subagent-locks/` —
  exclusive per-child-session resume locks, global concurrency slots, and run process
  identity records for orphan reconcile.
- `launch.ts`: resolve the child `pi` invocation via `PI_SUBAGENT_BIN` or
  `process.execPath` + CLI entry (bare PATH name only as last-resort fallback).
- `persistence.ts`: versioned active-branch event folding and bounded child transcript metadata.
- `maintenance.ts`: filesystem GC (session files) and abort-race helpers; kept out of persistence.
- `usage.ts`: provider-reported root/subagent/combined accounting.
- `policy.ts` / `schema.ts`: discriminated request validation and safe capability profiles.
- `config.ts`: defaults ← `~/.pi/subagent.json` ← `PI_SUBAGENT_*` env overrides.
- `agents.ts`: named agent files (`.pi/agents/`, `.agents/agents/`, global agent dir).
  Flat-YAML frontmatter + markdown persona body; resolved in policy with explicit
  params > agent file > profile taskDefaults > parent inheritance. Catalog refreshes
  lazily (5s TTL) so new files work mid-session; symlinks and oversized files skipped.
- `notifications.ts`: background-run completion batching. Successes group within a
  debounce window (hard cap on hold time); failures bypass batching and flush
  immediately; delivered-state is re-checked at flush time so a consuming `wait`
  suppresses the redundant notification.
- `ui.ts`: renderers, footer status and `/subagents` inspector. The ambient widget
  (extension-side) shows BACKGROUND runs only — foreground runs render inline as the
  tool result, so widget display would double-render them.
- `extension.ts`: wiring only; no business logic. Nested children at the depth ceiling do
  not re-register the tool; only top-level parents run maintenance.

Invariants:

1. A run belongs to exactly one parent session key and cannot update another session.
2. No more than `maxActiveProcesses` children run per extension runtime, and no more than
   `maxGlobalActive` across every Pi parent process on the machine.
3. Cancellation prevents queued tasks from spawning.
4. A child session may have only one direct resume writer at a time, enforced by an
   in-memory lock *and* a durable file lock under `lockDir` that survives crashes and
   coordinates across independent parent processes.
5. Parallel write-capable tasks need isolated worktrees/distinct cwd or explicit unsafe opt-in.
6. Every tool response is globally capped to 50 KB / 2,000 lines; full data lives in artifacts/transcripts.
7. Status is compact; wait is the one-shot deliverable.
8. On shutdown or tree navigation, child runs are cancelled and awaited for a bounded grace period.
9. On startup, orphan process groups recorded under `lockDir` are reaped (SIGTERM then SIGKILL)
   before any matching child session is eligible for resume. `$state: "lost"` is a labeling
   that keeps `resumeBlocked` until reconciliation proves death.
10. Billed usage is folded once per root message and once per full child run UUID.
11. Checkpoint persistence events are lightweight (state, usage, process identity, pointers).
    Full transcripts and final output are persisted exactly once, in the terminal event.
12. High-frequency registry "changed" events coalesce (trailing window); state transitions,
    new child sessions, billed-usage advances, and terminal events flush immediately.
13. `wait` is interruptible: aborting a wait returns promptly and does NOT cancel the
    background run. Only `cancel` (or parent shutdown) aborts a run.
14. Budget stops (`max_turns`/`max_cost`) with at least one completed turn end as `partial`
    and deliver their output normally. Streams truncated after useful assistant output also
    end as `partial`. Timeouts report `state: "timeout"` with `timeoutPhase`.
15. `timeout_ms` covers the whole task, including semaphore queue time, but the phase
    (queued / starting / running) is recorded so agents can apply the right retry policy.
16. Worktrees live under a durable root (`~/.pi/subagent-worktrees`), never a purgeable OS
    tmpdir. Startup maintenance (top-level parents only) prunes stale git registrations,
    removes unchanged leftovers, and sweeps changed-but-expired worktrees. Live-run
    worktrees are always shielded.
17. Process-tree reaping after a clean exit can be disabled per task with `keep_background`
    (for legitimately backgrounded work such as dev servers); forced stops always reap.
18. Protocol completion prefers Pi's `agent_settled` event. Legacy `agent_end` without
    `willRetry` is accepted for older Pi builds; `agent_end` with `willRetry: true` is
    treated as non-terminal.
19. Depth parsing fails closed on malformed values so env scrubbing cannot silently reset
    the counter to top-level.
20. Budget breaches (`max_turns`/`max_cost`) steer a wrap-up message and allow grace
    turns before SIGTERM; a child that concludes within grace ends `partial` with
    `wrappedUp: true`. `graceTurns: 0` restores immediate stops.
21. Transient failures (queued timeout, stall, spawn error, provider error, protocol
    truncation) retry up to `maxRetries` extra attempts, escalating through
    `fallback_models`; usage accumulates across attempts and `attemptedModels` is
    recorded. Task-quality failures (nonzero exit with complete protocol, cancellation,
    budget stop, running timeout) never retry.
22. The stall watchdog treats protocol silence as suspect, not fatal: after
    `stallAfterMs` the task is flagged and probed via `get_state` (a live child's
    answer clears the flag); only continued silence for `stallKillAfterMs` more kills
    the child — which is then a transient failure eligible for retry.
23. Only `async: true` runs notify on completion and appear in the ambient widget.
    Notification delivery respects delivered-once: a `wait` that consumed the run
    suppresses the notification.
24. Named agent files supply per-field defaults only; explicit request params always
    win, and capability profiles fail closed regardless of what an agent file declares.
