# CLAUDE.md

## What this project is

A context and token manager for Claude Code. It hooks the agent lifecycle to
shorten bulky tool results before they enter the context window, deny redundant
re-reads, and persist project knowledge across compaction.

Read `ARCHITECTURE.md` before changing anything in `src/` or `hooks/`. It
documents invariants that look safe to break locally and cause problems
elsewhere.

## Working agreement

- Every change must leave `npm test` and `npm run eval` passing. Run both
  before considering any task done.
- `eval` exits non-zero if any critical pattern is lost. That is a hard gate,
  not a warning.
- One task per commit. Conventional commit messages.
- No new runtime dependencies in `src/` or `hooks/` without an explicit note in
  the task. Hooks spawn on every tool call; startup time is the budget.

## Invariants — do not break these

1. **Never rewrite conversation history.** Prompt caching keys on an exact
   prefix. Only shape content on the way in.
2. **Pruning must be reversible.** Every prune stashes the original and emits a
   retrieval pointer. A prune without a pointer is data loss.
3. **Cache reads are never pruned.** `passthroughPaths` exempts `.ctxkeep/`,
   otherwise expansion loops.
4. **Fail open.** Every hook catches its own errors and exits 0. A broken
   ctxkeep must look like no ctxkeep, never like a broken session.
5. **Hook output is capped at 10,000 characters**, including
   `additionalContext`.
6. **Injected context is phrased as statements, not instructions.**
7. **Hooks do mechanics, the skill does judgment.** No model calls in a hook.

## Do not do

- Do not add LLM calls to any hook.
- Do not quote eval-harness percentages as real-world savings anywhere in
  user-facing docs. They are synthetic fixtures.
- Do not implement features from `TASKS.md` out of order across phase gates.
- Do not delete or weaken a test to make it pass.
- Do not add telemetry or any network call that runs without explicit opt-in.

## Where things are

```
bin/cli.js       init · doctor · stats · expand
hooks/           lifecycle entry points, one per event
src/             the logic hooks call
skills/          the agent-facing half
eval/            fidelity + savings on fixtures (hard gate)
bench/           end-to-end cost measurement against live Claude Code
test/            unit tests
```
