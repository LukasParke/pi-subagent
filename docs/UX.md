# pi-subagent UX

## Overview
The standalone pi-subagent provides rich TUI support for monitoring, inspecting, and interacting with isolated subagent runs (single and parallel modes). UI logic is kept independent from `runner`/`registry` via small structural adapters (`SubagentAdapter`).

Key features:
- **Footer status**: Compact live status (running count, ready count, and root/subagent/combined provider usage). Supports running + completed-undelivered states and keeps session totals visible after delivery. Shows `/subagents`; notifications fire once per terminal run ID.
- **/subagents overlay**: Full-screen inspector with list view and detail view. Scrollable transcript/activity. Robust lifecycle (animation timers disposed, requestRender driven).
- **Formatting layer**: Elapsed time, compact tokens/usage, safe paths, tool call previews, activity with live text + spinners. ANSI-safe width handling (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`).
- **Parallel support**: Collapsed = one line per task. Expanded works **while tasks are running** (liveText, spinners, elapsed update via single owned animation interval ~8fps). Key hint for `app.tools.expand` (Tab toggles).
- **Effective profile**: RO/RW indicators with icons, model/thinking/cost shown where available.
- **Actions**: Navigation (arrows/j/k), Enter (drill-down), Esc/back (close/back), c (cancel), d (dismiss), r (resume), o (output/action). Emits typed `UIAction` instead of direct registry calls.
- **Output pointers**: sessionId, outputFile, worktree shown as metadata/preview (status action uses compact formatting helper, not full summary).
- **Robustness**: Single animation interval while spinners/running visible. Always disposes timers/listeners. Pure UI model tests cover navigation, expanded live parallel, truncation, ready state, disposal simulation.

## Controls (documented in keybindings where namespaced)
- `/subagents` → opens overlay (overlay: true)
- In list:
  - ↑/↓ or j/k: navigate
  - Enter/return: drill to selected detail
  - c: cancel running task
  - d: dismiss completed
  - r: resume session
  - o: show output (file/session pointer)
  - Esc/q: close
- In detail:
  - ↑/↓/pg keys: scroll transcript/activity (full messages, tool calls, live text)
  - Esc/b: back to list
  - Same action keys (c, r, o, d)
- Footer updates live; notifications for state transitions (e.g. "subagent completed, ready for delivery").

## States
- **Queued/Running**: Spinner, liveText, elapsed updating, profile (RO/RW), model/cost.
- **Completed/Partial/Failed/Cancelled**: Icon change (✓/✗), usage summary, output pointers.
- **Parallel**: Collapsed shows per-task line (label/state); expanded shows full with live updates even mid-execution. Expanded mode MUST remain functional.
- **Delivered vs Undelivered**: Footer tracks pending delivery; does not auto-clear.
- **Notification**: One per terminal transition to avoid spam.
- **List/Detail**: Scrollable full transcript in detail; adaptive to width; keyHint for expand.

## Integration Notes
- Extension wires via `ctx.ui.custom((tui, theme, kb, done) => createSubagentsOverlay(tui, theme, adapter, done), {overlay: true})`
- Adapter provides getActiveRuns/getCompletedRuns/cancelRun etc. without tight coupling.
- Tests combine pure UI models with a headless Pi extension harness: format helpers, navigation, truncation, ready state, renderer contracts, lifecycle actions, timers, and disposal.
- Status output = metadata/preview only (`formatStatusPreview`).
- Follows Pi TUI guidelines (render(width), handleInput, invalidate, requestRender, dispose). One owned animation interval.

See ARCHITECTURE.md for ownership boundaries. All rendering respects terminal width and ANSI safety.

Tool-call expansion uses Pi's `app.tools.expand` binding. Overlay navigation currently uses the documented fixed keys above.

Updated: 2026-07-09
