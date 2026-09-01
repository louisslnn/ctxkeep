# ARCHITECTURE.md

How ctxkeep is put together, and the decisions that are easy to break locally
and cause problems elsewhere. The hard invariants are enumerated in `CLAUDE.md`;
this file records the reasoning behind the ones that need it.

## Shape of the thing

Two halves, deliberately kept apart:

- **Hooks** (`hooks/`) do *mechanics* — prune, dedupe, snapshot, re-inject. No
  model calls, ever. A hook spawns on every tool call, so anything it does is on
  the critical path forever.
- **The skill** (`skills/ctxkeep/`) does *judgment* — what to record as memory,
  when an elided artifact is worth expanding. That is where a model belongs.

`src/` is the logic the hooks call; it has no Claude Code dependency and is unit
tested directly. `eval/` measures fidelity (did pruning destroy anything
critical?) against fixtures and is a hard gate. `bench/` measures real cost.

## Pruning

The head/tail pruner (`src/prune/lines.js`) keeps the top and bottom of a long
artifact and elides the middle, on the theory that the middle is the least
load-bearing part of most tool output. Every prune stashes the full original
under `.ctxkeep/cache/` and appends a retrieval pointer, so it is always
reversible.

### Line numbers across an elision (task 1.5)

A `Read` result is line-oriented: a model may reason about *line positions* in a
file it read, and a downstream `Edit` or a message like "the bug is around line
840" depends on those positions being true.

The subtlety, confirmed by capturing a real payload (`test/fixtures/payloads/read.json`):
the `tool_response` a hook receives carries the file's **raw content, without
line-number prefixes**. The `1→`, `2→` gutter a model sees is added by Claude
Code's renderer *after* the hook runs. So if ctxkeep elides the middle and hands
back head+tail, the renderer numbers the surviving lines **sequentially from 1**,
and every tail line is now labelled with a number far lower than its true source
position. That is silent line-number drift.

**Decision: state the original source line range explicitly in each elision
marker.** A marker now reads:

```
… 760 lines elided … (original lines 101-860)
```

The head is always source lines `1..headLines`; each marker names exactly which
source lines it stands in for; so the first surviving tail line's true number is
one past the last marker's range, and every kept line's position is recoverable
from the text itself — independent of how the renderer numbers it.

This was chosen over *rewriting every surviving line with an explicit `N→`
prefix* because that risks double-numbering (the renderer may add its own gutter
on top) and is a larger, shape-dependent change. The marker approach is
self-contained, needs no per-line rewriting, and keeps the existing marker
format (`… N lines elided …`) as a prefix so nothing downstream that matched the
old marker breaks.

When error lines are salvaged out of the middle (`keepMatching`), the elision
splits into several gaps; each gap reports its own range independently.

The fidelity of this is asserted by the `read-line-numbers` eval fixture (a
surviving tail line still carries its correct source number, and the marker
names the correct elided range) and by `test/lines-elision.test.js`.

## Session state

Session state (the dedupe read-table plus session scalars like `startedAt`) is
an **append-only log**, one line per event, under `.ctxkeep/state/`. Claude Code
runs tools in parallel, so a read-modify-write of one shared JSON file let the
last writer clobber concurrent entries and dedupe silently missed files. Each
hook now only ever *appends* its own line (atomic for small records), and
`readState` reconstructs the current state by replaying the log. See task 1.2.

## Cache lifecycle

Pruned artifacts under `.ctxkeep/cache/` are swept by age on **SessionStart**
(`sweepCache`, retention `config.cache.retentionDays`, default 7). The sweep
never runs on `PostToolUse`: that is the hot path, and a directory scan there
would tax every tool call to clean up state that only grows between sessions.
See task 1.3.
