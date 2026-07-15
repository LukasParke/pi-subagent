# Security model

Pi packages run with full system access. This extension spawns child `pi`
processes that inherit the parent environment (including provider credentials)
and can use tools according to their capability profile.

## What subagents can do

| Profile | Default tools | Writes? |
|---------|---------------|---------|
| `explore` | `read`, `grep`, `find`, `ls` (+ explicit read-only extras) | No |
| `review` | same as explore | No |
| `general` | inherited active tools (may include `bash`/`edit`/`write`) | Yes |

Parallel mode defaults to `explore` to avoid concurrent shared writes.

## Hard rules

1. **Read-only means no `bash`.** `bash` can rewrite the disc and is never part of
   an explore/review profile.
2. **Parallel writers** require `isolation: "worktree"`, distinct `cwd` values,
   or an explicit `allow_shared_writes: true` opt-in.
3. **Depth is capped** (`maxDepth`, default 2). Nested children at the ceiling do
   not re-register the subagent tool. Depth is scheduling metadata — `bash` or an
   env-scrubbing wrapper can still invoke `pi` directly, so treat it as an
   accidental-recursion guard, not a security boundary.
4. **Process caps** limit concurrency both per parent session (`maxActiveProcesses`)
   and machine-wide (`maxGlobalActive`, default 16).
5. **Transcripts** under `~/.pi/subagent-sessions` may contain task content, tool
   output, and secrets that appeared in context. Protect that directory. Task text
   is delivered via stdin (not argv) so it stays out of `ps` listings, but it is
   still written into the child session log.
6. **Background permission prompts** are limited because children run headless
   (RPC mode). Extension UI dialogs raised inside a child are auto-cancelled so
   they can never hang a run — which also means a child can never obtain
   interactive consent. Prefer restricted tools for async/background runs.
11. **Steering messages** (`action: "steer"` and the overlay `s` key) inject text
    into a running child's conversation with user-level authority. Anything that
    can call the subagent tool can steer any live run in the same session.
7. **Process cleanup.** On POSIX, children run in their own process group so tree
   kills work for ordinary descendants. Parent (re)start reaps orphans recorded
   under `~/.pi/subagent-locks/runs/` so resume cannot race a still-alive writer.
   Grandchildren that call `setsid()` can still escape a simple process-group kill.
8. **Resume exclusivity.** Direct resume takes a durable per-session file lock;
   concurrent parents cannot append to the same child session.
9. **Profiles are tool-selection policy, not a sandbox.** Children inherit
   `$HOME`, SSH/cloud credentials, network access, and the parent filesystem.
   Git worktrees only isolate the checkout. For untrusted tasks, use an outer
   container/cgroup/network policy.
10. **`max_cost` is accounting, not a hard provider gate.** Usage arrives after a
    turn; orphans may spend money the ledger never sees. Combine with provider
    account budgets for hard spend limits.

## Trust and project cwd

If `cwd` points outside the parent project, the child inherits whatever local
project config/trust applies to that path. Treat external `cwd` as elevated risk
and prefer read-only profiles when exploring third-party trees.

## Output artifacts

`output` files are written by the child. Resolve paths carefully and reject
duplicate output paths across parallel workers.

## Named agent files

Agent files (`.pi/agents/`, `.agents/agents/`, global agent dir) inject their
body into the child's system prompt and set its model/tools/budgets. A
project-level agent file shapes subagent behavior the same way project
extensions and skills do — review them like code when working in untrusted
repositories. Mitigations: capability profiles still fail closed (an agent
cannot grant write tools under `explore`/`review`), symlinked agent files are
skipped, names are validated against traversal characters, and files over
64KB are ignored.

## Machine-wide state

`~/.pi/subagent-locks/` holds session locks, global concurrency slots, and run
process identity records. It is per-user (under `$HOME`) and must not be shared
across untrusted users/containers without care — a compromised client could
interfere with lock reclaim on the same account.
