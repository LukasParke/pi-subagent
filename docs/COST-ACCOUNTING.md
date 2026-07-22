# Cost accounting

`pi-subagent` reports three independent ledgers:

- **root** — provider-reported usage from assistant messages on the active parent-session branch.
- **subagents** — provider-reported cumulative usage from child-run checkpoints and terminal events on that same branch.
- **combined** — root + subagents.

These totals appear in `subagent { action: "status" }`, per-run status, the `/subagent-cost` command, and the `/subagents` overlay header. The footer stays terse (running/ready counts only) because Pi's native footer already shows session cost — including subagent spend, on Pi builds with native tool-result usage accounting (see below).

## Source of truth

The extension does not estimate prices. It uses Pi's normalized provider response:

```ts
message.usage.cost.total
```

It also retains provider-reported input/output/cache category costs, token counts, reasoning tokens, context size, and completed turn count when supplied.

## Native Pi usage accounting

Pi builds after v0.80.10 persist an optional `usage` field on tool-result messages ([pi#6671](https://github.com/earendil-works/pi/pull/6671)) and fold it into the native footer total, `/session` statistics (as `Tools/summaries`), and RPC `get_state` totals.

The extension participates in both directions:

- **Upward** — the tool result that *delivers* a run (foreground completion, or the first `wait`) carries the run's total provider usage as native `usage`. Attachment is gated on the same delivered-flag transition as output delivery, so it happens exactly once per run UUID. Status, replayed waits, steer, diff/apply/discard, and plan responses never attach usage. Older Pi hosts copy only `content`/`details` from tool results and silently ignore the field — safe on every version this package supports.
- **Downward** — a child's event stream may contain tool-result messages that themselves carry nested usage (for example, a grandchild subagent on a new-Pi child). The parent folds that into the run's cumulative usage, so `max_cost` budgets and both ledgers see true subtree spend. Pre-#6671 children simply never emit the field.

Known undercounts in the **native** total (the extension ledger still counts these from persisted entries):

- A background run dismissed in the overlay (or via status) without a delivering `wait` never produces a tool result, so its spend reaches only the extension ledger.
- A failed or lost run raises an error instead of returning a tool result; any pre-failure usage likewise reaches only the extension ledger.

Because the native footer counts parent assistant messages plus delivered tool-result usage, and the extension's **combined** counts the same runs by UUID, the two agree whenever every terminal run was delivered.

## Deduplication rules

1. Root assistant messages are counted once by session-entry ID.
2. Each subagent run is counted once by full run UUID; the newest live/checkpoint/terminal cumulative value replaces older values.
3. Delivery, dismissal, status, and checkpoint events never add cost.
4. If an old run is evicted from in-memory UI history, its latest persisted usage still contributes to the session ledger.
5. Active and immediately completed runs supplement or replace stale persisted checkpoints until newer session entries become visible; the full run UUID prevents double counting afterward.
6. Resumed and forked invocations are distinct billed runs. Their new provider usage is counted once, even though they reuse prior context.
7. Retry attempts (transient-failure retries and model fallbacks) accumulate into their
   run's single usage record — every attempt's billed usage counts once, under one run
   UUID, with `attemptedModels` recording the escalation path.
8. The optional parallel `synthesis` child bills into the same run as an extra result.
9. Native `usage` on the delivering tool result mirrors rule 2's run totals and is attached at most once per run (delivered-flag gated), so Pi-side totals cannot double count a run either.

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
