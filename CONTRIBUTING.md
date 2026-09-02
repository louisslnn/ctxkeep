# Contributing to ctxkeep

ctxkeep is a context and token manager for Claude Code: it hooks the agent
lifecycle to shorten bulky tool results before they enter the context window,
deny redundant re-reads, and persist project knowledge across compaction.

Read `ARCHITECTURE.md` before changing anything in `src/` or `hooks/`. It
documents invariants that look safe to break locally and cause problems
elsewhere.

## Requirements

- Node.js >= 20. No runtime dependencies, and no lockfile — everything runs on
  a bare Node install.
- **Do not add runtime dependencies to `src/` or `hooks/`.** Hooks spawn a
  process on every tool call; startup time is the budget. A dependency there
  needs an explicit note in the task justifying it.

## Running the checks

Both must pass before a change is done. CI runs them on Node 20 and 22.

```sh
npm test        # unit + end-to-end hook tests (node --test)
npm run eval    # fidelity + savings on fixtures — HARD GATE
```

`npm run eval` exits non-zero if any fixture's `lost` count is above 0. `lost`
means a pattern the fixture declared critical is neither visible in the pruned
text nor recoverable through the retrieval pointer. That is a build failure, not
a warning. Do not weaken a fixture or a test to make a check pass.

## Adding an eval fixture

The eval harness measures two things per fixture: how much was saved, and — the
one that matters — what survived. Each fixture declares `critical` patterns that
must still be findable after pruning.

1. **Capture real tool output.** Run the actual tool in a throwaway project and
   save its output; don't hand-write what you think it looks like. The bundled
   cross-language fixtures (`bash-pytest-failure`, `bash-go-test-failure`,
   `bash-cargo-test-failure`) were captured from real pytest/go/cargo runs.

2. **Add two files under `eval/fixtures/`:**
   - `<name>.txt` — the captured output.
   - `<name>.json`:
     ```json
     {
       "name": "<name>",
       "tool": "Bash",
       "textFile": "<name>.txt",
       "critical": ["a regex per line that MUST survive"]
     }
     ```
   `critical` entries are regular expressions (matched with the `m` flag), so
   escape regex metacharacters. Every pattern must genuinely appear in the
   captured output — a pattern that doesn't is reported as `lost` and fails the
   build. You can inline short output with `"text": "..."` instead of `textFile`.

3. **Run `npm run eval`.** Aim for critical patterns to stay *inline* (visible
   without a follow-up read), not merely *recoverable*. For command output, the
   `Bash` rule's `keepMatching` regex in `src/config.js` salvages error-ish
   lines from the elided middle. Test runners format failures differently —
   pytest and cargo group their failure detail at the head/tail of a run, while
   `go test` interleaves it — so a new ecosystem may need a `keepMatching`
   addition. If you change that regex, re-run the whole eval to confirm you
   haven't regressed the existing fixtures.

## Invariants — do not break these

From `CLAUDE.md` and `ARCHITECTURE.md` §6. Each looks safe to break locally and
causes a subtle problem elsewhere.

1. **Never rewrite conversation history.** Prompt caching keys on an exact
   prefix; only shape content on the way *in*.
2. **Pruning must be reversible.** Every prune stashes the original and emits a
   retrieval pointer. A prune without a pointer is data loss.
3. **Cache reads are never pruned.** `passthroughPaths` exempts `.ctxkeep/`,
   otherwise expanding a pruned artifact loops.
4. **Fail open.** Every hook catches its own errors and exits 0. A broken
   ctxkeep must look like no ctxkeep, never like a broken session.
5. **Hook output is capped at 10,000 characters**, including
   `additionalContext`.
6. **Injected context is phrased as statements, not instructions.**
7. **Hooks do mechanics; the skill does judgment.** No model calls, no network,
   in a hook.

## Commits

One task per commit, conventional commit messages (`fix:`, `feat:`, `docs:`,
`test:`, `chore:`, `ci:`, `eval:`). Don't batch unrelated changes.

## For maintainers — GitHub repo settings

These can't be set from a PR; paste them into the repository settings.

**Description (one line):**

> Context & token manager for Claude Code — reversibly prunes bulky tool output, dedupes repeat file reads, and persists project memory across compactions.

**Topics:**

```
claude-code, claude-code-plugin, context-management, token-optimization, hooks, llm, developer-tools, cli, nodejs, prompt-engineering
```
