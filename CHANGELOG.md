# Changelog

All notable changes to ctxkeep are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing released yet. The work below is on the path to a first `0.1.0` and is
grouped by the phase that produced it.

### Phase 0 — repository correctness

- **Fixed:** plugin manifest moved to `.claude-plugin/plugin.json`, the path
  Claude Code expects, so the documented plugin install path works (0.2). This
  also satisfies the packaging manifest requirement (0.4): `npm pack --dry-run`
  now lists `.claude-plugin/plugin.json` in the tarball.
- **Removed:** foreign VS Code extension artifacts (`kickbacks-*`) from the
  working tree; added `*.vsix` to `.gitignore` (0.3).
- **Docs:** the README eval table is labelled as synthetic-fixture output — it
  measures the harness, not real sessions, and is not a real-world savings claim
  (0.6).
- **Deferred (recorded in `BLOCKED.md`, not yet resolved):**
  - The project name is not yet settled across `package.json`, bin, skill
    directory, config filename, plugin, and docs; the naming decision and npm
    availability were recorded rather than applied (0.1).
  - The install path (publish vs install-from-source vs marketplace) was
    recorded as a blocker rather than resolved (0.5).

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

[Unreleased]: https://github.com/louisslnn/HyperCompressor/commits/main
