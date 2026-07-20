# Changelog

## 0.5.0

### Native Pi cost accounting (pi#6671)

- **Upward**: the tool result that delivers a run (foreground completion or
  the first `wait`) now carries the run's total provider usage as a native
  `usage` field. Pi builds after v0.80.10 persist it on the session entry and
  fold it into the footer cost, `/session` statistics (`Tools/summaries`
  bucket), and RPC `get_state` totals — resolving the undercount that
  motivated [pi#6509](https://github.com/earendil-works/pi/issues/6509).
  Attachment is delivered-flag gated: exactly once per run UUID; status,
  replayed waits, steer, worktree actions, and plan responses never attach
  usage. Older Pi hosts silently ignore the field (no minimum version bump).
- **Downward**: tool-result messages in a child's event stream that carry
  nested usage (e.g. grandchild subagents on a new-Pi child) now fold into
  the run's cumulative usage, so `max_cost` budgets and the
  root/subagent/combined ledger see true subtree spend. Pre-#6671 children
  never emit the field; behavior there is unchanged.
- Known native-total gaps documented in COST-ACCOUNTING.md: dismissed-without-
  wait background runs and failed/lost runs (thrown errors carry no usage)
  reach only the extension ledger.

## 0.4.0

### Agent ecosystem (PLAN phase 2)

- **`spawns:` allowlist** in agent frontmatter (`false` / `"*"` / name list):
  controls which agents a persona's children may spawn. The policy travels via
  `PI_SUBAGENT_SPAWNS`; `spawns: false` children don't register the subagent
  tool at all. Malformed env fails closed to disabled. Accidental-recursion
  guard, not a security boundary (documented in SECURITY.md).
- **`@include relative/path.md`** in agent bodies: one-level prompt
  composition with the same 64KB/symlink guards as `@contract.json`;
  missing/rejected includes stay verbatim.
- **Resumable-session discovery**: bare `status` lists `session <id8>
  (resumable)` under completed runs; run-specific `status` shows full ids, and
  the prompt guidelines mention `resume:`.
- **`action: "plan"`** dry-run: full validation plus worktree/fork/output
  preflights, returning the resolved per-task plan (model, tools, budgets,
  isolation, notes) without spawning — same errors as the real call.

### Engine hardening (PLAN phase 3)

- **Depth-tiered global slots**: slot records carry `depth` and shallow tiers
  reserve capacity for deeper ones, so a spawn tree wider than
  `maxGlobalActive` can no longer deadlock while parents wait on children.
  Old slot files without `depth` count as depth 0.
- **`include_wip: true`** (worktree isolation only): seeds the worktree with
  the parent checkout's uncommitted changes. `diff`/`apply` subtract the WIP
  patch when clean, else report the combined delta with an explicit
  `[includes parent WIP]` warning; an untouched WIP-only worktree counts as
  unchanged and is cleaned up.
- **Faster stale-lock reclaim**: a lease-expired cross-host (or unverifiable
  foreign) owner is reclaimable after one lease period; the 2× window remains
  only where clock skew is plausible (same host, identity unknown).
- **Library-use warning**: `runSubagent()` without `locks` + `runId` writes no
  durable run record (children invisible to orphan reclaim) — now documented
  loudly in JSDoc and README.

### Observability (PLAN phase 4)

- **Live transcript view**: in `/subagents`, `t` on a running run tails the
  child's session file (500ms poll, auto-follow, scroll-up pauses); `s` steer
  works from the same view.
- **`widget: "off"` / `notifications: "off"`** config keys (env
  `PI_SUBAGENT_WIDGET` / `PI_SUBAGENT_NOTIFICATIONS`) for quiet mode.
- Status previews append `[stalled <dur>]` and `[attempt N]` so background
  polling surfaces watchdog/retry state without the overlay.

## 0.3.1

- Remove `publishConfig.provenance` (it blocked the one-time local bootstrap
  publish of the new package name; OIDC publishes generate provenance
  automatically). First release published end-to-end via Trusted Publishing
  under `@parke.dev`.

## 0.3.0

### Structured results

- **`output_schema`**: declare a JSON Schema per task (or in agent-file
  frontmatter as inline JSON / `@contract.json`). The contract is appended to
  the child's system prompt; the final message must end with a fenced
  `json:result` block. Validation runs parent-side against a dependency-free
  JSON-Schema subset (type/properties/required/items/enum/const; unknown
  keywords ignored). Invalid output triggers **one steer-based repair round**
  before the child is allowed to settle; still-invalid results end `partial`
  with `structuredError` and the raw text delivered — paid work is never
  discarded. Valid results deliver as clean JSON and surface as
  `details.results[].structuredOutput`.
- **Typed synthesis handoff**: validated parallel results feed the `synthesis`
  child as JSON blocks instead of prose tails, with per-task validity flags.
- **Arg repair**: double-encoded task/system-prompt text (literal `\n`/`\"`
  escapes) is conservatively de-mangled once at validation time; identifier
  fields and path-like strings are never touched.
- UI: terminal rows annotate `✓ schema` / `schema ✗`.

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
