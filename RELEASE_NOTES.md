# ctxkeep v0.1.0

Context and token management for Claude Code. ctxkeep hooks the agent lifecycle
to shorten bulky tool results before they enter the context window and to persist
project memory across compaction — reversibly, and failing open so it can never
break a session.

## What ships

- **Pruning** — the working lever. Long tool results are shortened on the way
  into context: head and tail kept, the middle elided with a marker, error-ish
  lines salvaged, and the full text stashed under `.ctxkeep/` with a retrieval
  pointer. Delivery into a live `claude -p` session is verified end to end, not
  just logged.
- **Memory** — implemented, **untested**. `CONTEXT.md` is snapshotted before
  compaction and re-injected at session start. No benchmarked session reached
  compaction, so this is shipped but unproven.

## What was removed

- **Read-dedupe.** Built, then removed after two rounds of measurement: it fired
  zero times on focused tasks, and when a redesign made it fire on wide work it
  was net-negative (the agent routed around denials with a shell read), while
  costing a full-file hash on every read. See `ARCHITECTURE.md` §12.

## The honest ceiling

Measured across 699 real tool results, tool output is **~1/5 of the peak context
window** and **~0.2% of total billed input tokens** — the bill is dominated by
prefix size × turns, not any single result. Pruning is therefore a real but
**bounded** lever. **There is no end-to-end savings number:** the one wide
benchmark shake-out was 0/9 (no run completed the task), so no cost delta can be
attributed yet.

Full measurements and design rationale — including why the founding premise was
overturned (§11), why dedupe was removed (§12), and the shake-out result (§13) —
are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Install

From source — `git clone` then `npm install -g .`, then `ctxkeep init` per
project. See the [README](README.md). Requires Node ≥ 20; no runtime
dependencies.
