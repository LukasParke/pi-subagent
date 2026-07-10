# Cost accounting

`pi-subagent` reports three independent ledgers:

- **root** — provider-reported usage from assistant messages on the active parent-session branch.
- **subagents** — provider-reported cumulative usage from child-run checkpoints and terminal events on that same branch.
- **combined** — root + subagents.

These totals appear in `subagent { action: "status" }`, per-run status, the footer status, and `/subagents`.

## Source of truth

The extension does not estimate prices. It uses Pi's normalized provider response:

```ts
message.usage.cost.total
```

It also retains provider-reported input/output/cache category costs, token counts, reasoning tokens, context size, and completed turn count when supplied.

## Deduplication rules

1. Root assistant messages are counted once by session-entry ID.
2. Each subagent run is counted once by full run UUID; the newest live/checkpoint/terminal cumulative value replaces older values.
3. Delivery, dismissal, status, and checkpoint events never add cost.
4. If an old run is evicted from in-memory UI history, its latest persisted usage still contributes to the session ledger.
5. Active and immediately completed runs supplement or replace stale persisted checkpoints until newer session entries become visible; the full run UUID prevents double counting afterward.
6. Resumed and forked invocations are distinct billed runs. Their new provider usage is counted once, even though they reuse prior context.

## Branch semantics

Only `sessionManager.getBranch()` is used. Costs from abandoned sibling branches are excluded. When a parent session is forked, its inherited active-branch terminal entries remain part of that fork's historical total; new runs are added to the fork independently.

## Failure and cancellation

Any usage reported before a failure, timeout, budget stop, cancellation, or parent crash is retained in a cumulative checkpoint/terminal record. A run with no provider response contributes zero rather than an estimate.

## Provider limitations

Accounting is only as precise as the provider data normalized by Pi:

- Some providers may report zero or incomplete costs.
- `reasoning` is a subset of output tokens and is not added to output again.
- `contextTokens` is the latest turn's context size, not an additive billed-token field.
- The extension deliberately does not infer missing prices from a local model table.
