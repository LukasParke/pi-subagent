# pi-subagent

Production-grade isolated subagents for [Pi](https://github.com/badlogic/pi-mono).

Delegate research, parallel exploration, and clean-context review to child Pi
processes with cancellable background runs, session resume, worktree isolation,
capability profiles, a root/subagent/combined cost ledger, and a TUI inspector.

## Install

Pi packages install from **npm**, **git**, or a **local path**:

```bash
# npm (scoped; surfaces on the pi.dev gallery via the pi-package keyword)
# Note: unscoped "pi-subagent" is rejected by npm as too similar to "pi-sub-agent".
pi install npm:@lukehagar/pi-subagent@0.1.1

# latest npm
pi install npm:@lukehagar/pi-subagent

# git pin to a release tag
pi install git:github.com/LukasParke/pi-subagent@v0.1.1

# live main
pi install git:github.com/LukasParke/pi-subagent

# local checkout
pi install /absolute/path/to/pi-subagent
```

Then start Pi normally. The package registers:

- tool: `subagent`
- command: `/subagents`

Publishing is automated from `v*` tags — see [docs/RELEASING.md](./docs/RELEASING.md).

## Quick usage

```ts
// Single foreground task
{ task: "Find all call sites of parseConfig and summarize patterns." }

// Parallel read-only explorers (default profile: explore)
{
  tasks: [
    { task: "Map auth middleware flow" },
    { task: "List all env vars used in server/" }
  ]
}

// Background run
{ task: "Audit dependency licenses", async: true }
// later
{ action: "status", id: "abc123" }
{ action: "wait", id: "abc123" }
{ action: "cancel", id: "abc123" }

// Resume a child session
{ task: "Continue from your findings and propose a fix plan", resume: "<session-id>" }

// Isolated writers
{
  tasks: [
    { task: "Implement feature A", profile: "general", isolation: "worktree" },
    { task: "Implement feature B", profile: "general", isolation: "worktree" }
  ]
}
```

## Profiles

| Profile | Tools | Writes |
|---------|-------|--------|
| `explore` (parallel default) | read/grep/find/ls + safe extras | no |
| `review` | same as explore | no |
| `general` | inherited active tools | yes if tools include bash/edit/write |

Parallel write-capable tasks sharing one checkout are rejected unless each uses
`isolation: "worktree"`, distinct `cwd`, or explicit `allow_shared_writes: true`.

## Design invariants

1. A run belongs to one parent session and cannot update another session.
2. Global process semaphore + nesting depth caps prevent process storms.
3. Cancellation prevents queued tasks from spawning.
4. Direct resume of a child session is exclusive.
5. Tool responses are capped to ~50KB/2000 lines; full output lives in
   artifacts and `~/.pi/subagent-sessions`.
6. Status is compact; wait is the one-shot deliverable.
7. On parent session shutdown, live children are aborted and awaited briefly.
8. Provider-reported usage is counted once per root message and terminal child run.

## Layout

```
src/
  extension.ts     # Pi wiring only
  schema.ts        # request schema
  policy.ts        # profiles, normalization, write guards
  worktree.ts      # git worktree isolation
  orchestrator.ts  # multi-task execution
  runner.ts        # single child process lifecycle
  protocol.ts      # Pi JSON mode parser
  semaphore.ts     # concurrency limit
  registry.ts      # session-scoped run state
  persistence.ts   # parent-session event folding
  usage.ts         # root/subagent/combined usage ledger
  output.ts        # exact global output caps
  format.ts / ui.ts# renderers + /subagents overlay
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

`status`, the footer, and `/subagents` show separate **root**, **subagent**, and
**combined** totals based on provider-reported usage. Delivery and replay do not
double count runs. See [docs/COST-ACCOUNTING.md](./docs/COST-ACCOUNTING.md).

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
