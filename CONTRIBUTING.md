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

## Verifying delivery, not just the function

`npm test` and `npm run eval` are **function-level**: they check what a hook
*emits*. Neither can check what Claude Code actually *delivers* to the model
after applying `updatedToolOutput` — and that is a real, load-bearing gap. The
`replaceText` Read bug (`14667e4`) was a total failure of the most-pruned tool
that passed every unit test and eval fixture, because the hook emitted a
bare-string `updatedToolOutput` that Claude Code silently dropped for the nested
Read shape. Function tests could not see it; the model received the full file.

Genuine delivery verification **cannot be a `npm test` case**: whether an emitted
shape is accepted is behaviour of the live harness, so observing it needs a real
`claude` process, the network, and a non-deterministic session — everything a
hermetic CI suite must not require. So it lives out of band.

**Automated (needs a live `claude` CLI; costs one model call):**

```sh
bash test/delivery-check.sh
```

It configures ctxkeep's `PostToolUse` hook in a scratch project, drives a real
`claude -p` session that Reads a 600-line file (over the 400-line prune
threshold), then parses the session transcript for the *specific* Read
`tool_result` the model consumed. Exit 0 = the model received pruned output
(`[ctxkeep]` pointer present in the delivered result); exit 1 = it received the
full file (a delivery failure like the `replaceText` bug); exit 2 = could not run
(no `claude`). Note: it inspects the matched `tool_result`, not a `grep` of the
whole transcript — a grep can't fail, because the pointer string appears
elsewhere in the log.

Run it after any change to what a hook emits — chiefly `src/io.js` (`replaceText`)
and `hooks/post-tool-use.js` — and before a release.

**Manual fallback (no `claude` CLI, or release sign-off):**

1. In a project with ctxkeep's hooks active, Read a file longer than the `Read`
   rule's `maxLines` (default 400) — e.g. 600+ lines.
2. Look at what you receive. Correct delivery is a **head + `… N lines elided …`
   marker + tail**, ending in a `[ctxkeep]` pointer to `.ctxkeep/cache/…`. You
   should **not** see the whole file.
3. If you see the whole file, delivery is broken even though pruning "ran":
   check `.ctxkeep/metrics.jsonl` for a `prune` entry (the hook fired) and then
   the emitted `updatedToolOutput` shape — it is being dropped, not applied.

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

> Context & token manager for Claude Code — reversibly prunes bulky tool output and persists project memory across compactions.

**Topics:**

```
claude-code, claude-code-plugin, context-management, token-optimization, hooks, llm, developer-tools, cli, nodejs, prompt-engineering
```
