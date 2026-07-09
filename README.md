# pi-subagent

Production-grade isolated subagents for [Pi](https://github.com/earendil-works/pi-mono).

> Under active development. See `docs/ARCHITECTURE.md`.

## Install (local development)

```bash
pi install /absolute/path/to/pi-subagent
```

## Design

- Fresh child Pi context for each delegated task
- Foreground, parallel, and cancellable background execution
- Persistent child sessions with resume
- Read-only exploration/review profiles and guarded write parallelism
- Global process, cost, turn, timeout, and output budgets
- TUI footer + `/subagents` inspector
- Branch-aware parent-session persistence
