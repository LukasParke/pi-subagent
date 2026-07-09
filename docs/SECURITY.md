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
3. **Depth is capped** (`maxDepth`, default 2) to prevent recursive process storms.
4. **Global process caps** limit how many children can run concurrently.
5. **Transcripts** under `~/.pi/subagent-sessions` may contain task content, tool
   output, and secrets that appeared in context. Protect that directory.
6. **Background permission prompts** are limited because children run in JSON /
   print mode. Prefer restricted tools for async/background runs.
7. **Process cleanup is best-effort.** SIGKILL of the parent or machine crashes
   can leave orphans; process-group kills help on POSIX.

## Trust and project cwd

If `cwd` points outside the parent project, the child inherits whatever local
project config/trust applies to that path. Treat external `cwd` as elevated risk
and prefer read-only profiles when exploring third-party trees.

## Output artifacts

`output` files are written by the child. Resolve paths carefully and reject
duplicate output paths across parallel workers.
