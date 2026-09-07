# Changelog

All notable changes to ctxkeep are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-06

First public release. The honest one-paragraph story: three lifecycle mechanisms
were built — **prune** bulky tool output on the way into context, **dedupe**
redundant re-reads, and **persist memory** across compaction. Then they were
measured. Measurement overturned the founding premise (tool output is ~1/5 of the
context window and ~0.2% of billed input, not the dominant cost), so **pruning is
scoped honestly to what the data supports** — a real but bounded lever, with no
valid end-to-end savings number yet. **Dedupe was removed** after two measurement
rounds showed it net-negative when it fired. **Memory is implemented but
untested** — no benchmarked session reached compaction. What ships is pruning
(measured on the mechanism, reversible, fail-open) plus memory (unproven).

Highlights:

- **Prune** shortens long tool results before they enter context, reversibly
  (original stashed to `.ctxkeep/`, retrieval pointer appended). Read threshold
  tuned from 400→200 lines against a 699-`tool_result` payload sweep. Delivery
  into a live `claude -p` session is verified end to end, not just logged.
- **Dedupe removed.** It fired 0× across four single-bug calibrations; a
  file-identity redesign made it fire on wide work but 3 of 7 denials were routed
  around by the agent (net-negative), while costing a full-file hash on every
  read. Removed rather than kept on a maybe (`ARCHITECTURE.md` §12).
- **Memory** (`CONTEXT.md` snapshot on `PreCompact`, re-injected on
  `SessionStart`) ships but is untested end to end.
- **Honesty:** README and `ARCHITECTURE.md` state the measured ceiling plainly;
  eval percentages are labelled everywhere as synthetic-fixture mechanism
  numbers, not real-world savings. The one wide benchmark shake-out was 0/9
  (`ARCHITECTURE.md` §13).

The detailed record, grouped by the phase that produced it:

### Phase 0 — repository correctness

- **Fixed:** plugin manifest moved to `.claude-plugin/plugin.json`, the path
  Claude Code expects, so the documented plugin install path works (0.2). This
  also satisfies the packaging manifest requirement (0.4): `npm pack --dry-run`
  now lists `.claude-plugin/plugin.json` in the tarball.
- **Removed:** foreign VS Code extension artifacts (`kickbacks-*`) — from the
  working tree and from git history; `*.vsix` is gitignored (0.3). The binary
  blob is gone from all reachable history (`git rev-list --all --objects |
  grep -c vsix` → 0). A `grep` of `git log --all --name-only` still matches the
  word because a few commit messages *document* the purge; those are text, not
  artifacts. **Settled — a future audit need not re-investigate this.**
- **Docs:** the README eval table is labelled as synthetic-fixture output — it
  measures the harness, not real sessions, and is not a real-world savings claim
  (0.6).
- **Settled:** the project name is `ctxkeep` across `package.json`, bin, skill
  directory, config filename, plugin manifest, and docs (0.1).
- **Settled:** the install path is source-install (`git clone` + `npm install
  -g .`), documented in the README (0.5).

### Phase 1 — verified defects

Each fix landed with a regression test that fails before it and passes after.

- **Fixed:** `blockCompactUntilRecorded` was dead code — `startedAt` was read but
  never written, so the compaction gate never fired. `SessionStart` now stamps
  `startedAt` (1.1).
- **Fixed:** session state raced under parallel tool calls. It is now an
  append-only per-session log that concurrent `PostToolUse` hooks can't clobber,
  replayed on read (1.2).
- **Fixed:** the artifact cache was never garbage collected. Aged artifacts are
  now swept on `SessionStart`, off the hot path, with a configurable retention
  window (1.3).
- **Fixed:** the `tool_response` shape was unverified. Real payloads for Read,
  Bash, WebFetch and an MCP tool were captured as fixtures, and `extractText`
  was narrowed to the observed shapes while keeping a fallback (1.4).
- **Fixed:** line-number drift after pruning. Each elision marker now names the
  original source line range it stands in for, so line positions after an
  elision stay recoverable (1.5).
- **Fixed:** unmanaged `CONTEXT.md` growth. Truncation is section-aware (whole
  sections drop rather than a sentence cut mid-word) and `doctor` warns as the
  injection cap approaches (1.6).

### Phase 2 — trustworthiness (in progress)

- **Added:** GitHub Actions CI running `npm test` and `npm run eval` on Node 20
  and 22, both blocking (2.1).
- **Added:** end-to-end tests that drive each hook binary with realistic
  payloads and assert the emitted JSON, including the fail-open path — malformed
  input, missing config, and an unwritable cache directory each exit 0 with no
  output (2.2).
- **Added:** real captured eval fixtures for pytest, `go test` and cargo, each
  with critical failure patterns. Extended the `Bash` `keepMatching` regex to
  salvage `go test`'s interleaved failure markers and location lines; JS/TS
  fixtures unchanged (2.3).

### Phase 3 — measurement and scope

- **Measured:** a 699-`tool_result` payload sweep and per-session usage analysis
  overturned the founding premise. Tool output is ~1/5 of the peak context
  window and ~0.2% of billed input; the bill is dominated by prefix size ×
  turns. `README.md` and `ARCHITECTURE.md` §1/§5/§11 were corrected to this.
- **Tuned:** the Read prune threshold from 400→200 lines — 400 sat at the top of
  the real read-size distribution and caught almost nothing.
- **Removed:** read-dedupe. Two measurement rounds (0× on single-bug tasks;
  net-negative when it fired on wide work, 3/7 denials routed around) plus a
  structural mismatch — telling a wasteful re-read from a needed one is judgment,
  which hooks may not do — led to removing the hook, its state-tracking, config,
  stats reporting, and the third benchmark arm (`ARCHITECTURE.md` §12).
- **Benchmarked (inconclusive):** one 9-run shake-out on a wide exploratory
  fixture. Pruning fired (2–7 prunes/run) but 0/9 runs completed the task, so no
  valid savings number exists; the fixture is retained but flagged unsuitable as
  a cost baseline (`ARCHITECTURE.md` §13).
- **Verified:** end-to-end delivery — a fresh source install driving a real
  `claude -p` session confirmed the pruned output reaches the model, not just the
  metrics ledger.

[Unreleased]: https://github.com/louisslnn/ctxkeep/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/louisslnn/ctxkeep/releases/tag/v0.1.0
