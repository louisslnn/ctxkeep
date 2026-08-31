# Project context

Durable knowledge for this repo, carried across sessions and compactions.
Keep entries short and factual. Delete anything that has stopped being true.

## Decisions

- Two halves, kept separate: the hooks do mechanical pruning/dedupe/memory with
  no model judgment, and the skill (`skills/ctxkeep/SKILL.md`) holds the parts
  that need judgment. Reason: every piece of judgment moved into a hook becomes a
  model call on the critical path of every tool call, forever.
- The token counter (`src/tokenize.js`) is a character-ratio heuristic on
  purpose, not a real tokenizer. Reason: hooks spawn a process per tool call, so
  loading a BPE vocabulary would cost more latency than the pruning saves. Counts
  are directional, not exact.
- Hooks fail open: every entry point swallows its own errors and exits 0. Reason:
  a context optimizer must never break a session. `CTXKEEP_DEBUG=1` surfaces hook
  errors in the transcript.
- Pruning is always reversible: every shortened result ends with a `[ctxkeep]`
  pointer to the full text on disk under `.ctxkeep/`. Reason: the model must be
  able to recover an elided middle when it turns out to matter.
- Layout is canonical: tests in `test/*.test.js` (the `npm test` glob), eval in
  `eval/harness.js`, skill in `skills/ctxkeep/`. Files were reorganized to match
  the README; do not leave them stranded at repo root again.

## Constraints

- The error-preservation regex in `src/config.js` (`prune.Bash.keepMatching`)
  must NOT start with `\b`. A leading word boundary fails to match CamelCase
  names like `AssertionError`/`TypeError`, silently pruning away the one line
  that was the reason the command ran. This already cost a fixture on the first
  eval run.
- Hook output, including injected `additionalContext`, is capped at 10,000 chars
  by Claude Code. Past it, Claude Code writes to a file and passes a preview plus
  path — a wasted round trip. `buildDigest` caps injection well under this.
- `npm run eval` exits non-zero if any fixture's `lost` count is above 0 — a
  critical line pruned away and not recoverable is a build failure, not a
  warning. Keep it that way so it stays CI-usable.
- Injected memory must read as factual statements, not out-of-band instructions.
  Text that looks like a system command can trip prompt-injection defenses and be
  surfaced to the user instead of used.
- Bundled eval fixtures are tuned for JS/TS tool output and will not transfer
  cleanly to other stacks. Add fixtures from the target repo before trusting the
  savings numbers.

## Ruled out

- A real (BPE) tokenizer in the hooks — rejected: per-call vocabulary load costs
  more than the pruning saves. The heuristic estimator stays.
- Pruning turns already in context — rejected: prompt caching keys on an exact
  prefix, so rewriting a past turn invalidates everything after it and costs more
  than it saves. ctxkeep only shapes content on the way *in*.
- A compaction gate that can retrigger — rejected: it wedges a session against a
  full context window. `blockCompactUntilRecorded` fires at most once per session
  by design.

## Open threads

- `plugin.json` still ships placeholder `author.name` "YOUR NAME" and homepage
  "YOUR-USER" — fill in before any publish.
- The doctor check "hooks have fired at least once" stays red until Claude Code
  is restarted so the hooks in `.claude/settings.json` load and run against a
  real large-file read.
