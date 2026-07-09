# Architecture contract

`pi-subagent` is split by ownership boundary:

- `runner.ts`: one child process, Pi JSON protocol, cancellation, process trees, budgets.
- `registry.ts`: one parent-session runtime, global semaphore, run state, resume locks.
- `persistence.ts`: versioned active-branch snapshots and child transcript retention.
- `policy.ts` / `schema.ts`: discriminated request validation and safe capability profiles.
- `ui.ts`: renderers, footer status and `/subagents` inspector.
- `extension.ts`: wiring only; no business logic.

Invariants:

1. A run belongs to exactly one parent session key and cannot update another session.
2. No more than `maxActiveProcesses` children run globally per extension runtime.
3. Cancellation prevents queued tasks from spawning.
4. A child session may have only one direct resume writer at a time.
5. Parallel write-capable tasks need isolated worktrees/distinct cwd or explicit unsafe opt-in.
6. Every tool response is globally capped to 50 KB / 2,000 lines; full data lives in artifacts/transcripts.
7. Status is compact; wait is the one-shot deliverable.
8. On shutdown, child runs are cancelled and awaited for a bounded grace period.
