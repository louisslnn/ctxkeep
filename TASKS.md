# TASKS.md

Ordered backlog. Each task is independently verifiable — it has an acceptance
command that must pass. Work top to bottom. **Do not cross a phase gate until
every task above it is done and its gate command passes.**

For autonomous runs: complete one task, run the phase gate, commit, then move
to the next. Do not batch multiple tasks into one commit.

---

## Phase 0 — Repo is currently broken. Fix that first.

**Gate:** `npm test && npm run eval && node -e "require('fs').accessSync('.claude-plugin/plugin.json')"`

### 0.1 — Settle the name

The repo is `HyperCompressor`, `package.json` says `ctxkeep`, the README says
`ctxkeep`, the skill directory is `skills/ctxkeep/`, and the config file is
`.ctxkeep.json`. Pick one name and make everything agree: repo, package name,
bin name, skill directory, config filename, plugin name, and every mention in
docs.

Check npm availability before committing to a package name.

**Done when:** `grep -ril "ctxkeep\|hypercompressor" . --exclude-dir=.git`
returns only the chosen name.

### 0.2 — Fix the plugin manifest path

`plugin.json` is at the repo root. Claude Code expects
`.claude-plugin/plugin.json`. As it stands, the plugin install path documented
as "recommended" in the README **does not work**.

Move it, and fill in the `author` and `homepage` placeholders.

**Done when:** `.claude-plugin/plugin.json` exists with no placeholder values,
and root `plugin.json` is gone.

### 0.3 — Remove foreign artifacts

`kickbacks-inspect/` and `kickbacks-v2.vsix` belong to a different project. A
committed binary VS Code extension in an unrelated repo reads as
untrustworthy to anyone evaluating this.

Delete both. Note that deletion does not remove them from git history — with
only two commits, squashing to a clean initial commit and force-pushing is the
simpler fix. Add `*.vsix` to `.gitignore`.

**Done when:** neither path exists in the working tree, and `git log --all
--name-only | grep -c vsix` returns 0.

### 0.4 — Fix the packaging manifest

`package.json` `files` lists `.claude-plugin`, which currently does not exist,
so `npm pack` ships an incomplete package.

Verify with `npm pack --dry-run` that every path in `files` resolves and that
the tarball contains the plugin manifest, hooks, src, skills and bin.

**Done when:** `npm pack --dry-run` lists `.claude-plugin/plugin.json`.

### 0.5 — Correct the two false claims in the README

Both are documented as working and are not:

- `npm install -g ctxkeep` — the package is not published. Either publish it or
  replace with install-from-source instructions.
- `/plugin install ctxkeep@your-marketplace` — `your-marketplace` is a literal
  placeholder. Either set up a marketplace repo or remove the line.

**Done when:** every install command in the README has been executed
successfully from a clean machine or removed.

### 0.6 — Label the eval numbers

The README's `78%` table is from three synthetic fixtures. Read in context it
looks like a real-world savings figure, and that is the single most misleading
thing on the page.

Add a sentence directly above the table stating the numbers are from synthetic
fixtures, measure the harness rather than real sessions, and are not a
real-world savings claim.

**Done when:** no percentage appears in the README without an adjacent
statement of what produced it.

---

## Phase 1 — The verified defects

**Gate:** `npm test && npm run eval`

Each of these was confirmed by reading the code. Each needs a regression test
that fails before the fix and passes after.

### 1.1 — `blockCompactUntilRecorded` is dead code

`hooks/pre-compact.js` reads `state.startedAt ?? 0` to decide whether
`CONTEXT.md` was touched this session. **Nothing ever writes `startedAt`.** The
comparison always runs against epoch, so `touchedThisSession` is true whenever
the file exists, and the gate never fires. The README documents the feature as
working.

Fix: write `startedAt` from a `SessionStart` handler.

**Done when:** a test drives SessionStart → PreCompact with an untouched
`CONTEXT.md` and asserts the block decision is emitted; and a second test with
a touched file asserts it is not.

### 1.2 — Session state races under parallel tool calls

Claude Code runs tools in parallel. `readState` → mutate → `writeState` in
`src/store.js` is a read-modify-write with no locking, so concurrent
`PostToolUse` hooks clobber each other's entries. Effect: dedupe silently
misses files, with no error.

Fix options, in preference order: append-only state log, or one small file per
path key. Do not add a lockfile dependency.

**Done when:** a test spawns 20 concurrent `post-tool-use.js` processes against
distinct paths and asserts all 20 appear in state.

### 1.3 — Artifact cache is never garbage collected

Every pruned result writes a file to `.ctxkeep/cache/` and nothing ever removes
it. A long-lived project accumulates thousands.

Fix: age-based sweep on `SessionStart`, with a configurable retention window.
Never delete during `PostToolUse` — that is the hot path.

**Done when:** cache files older than the retention window are removed on
session start, and a test covers it.

### 1.4 — Confirm the `tool_response` shape

`src/io.js` probes several plausible shapes because the real one was never
confirmed against a live session. Everything downstream depends on this.

Capture real payloads using the logging hook in the README, for `Read`, `Bash`,
`Grep`, `Glob`, `WebFetch` and one MCP tool. Commit them as fixtures under
`test/fixtures/payloads/`. Narrow `extractText` to the shapes actually
observed, keeping the fallback.

**Done when:** `test/` contains real captured payloads and `extractText` is
tested against each.

### 1.5 — Line-number drift after pruning

`Read` results carry line numbers. Eliding the middle leaves a gap, so a model
reasoning about line positions in a pruned file can be wrong. String-based
edits are unaffected; anything line-oriented is exposed.

Decide and implement one of: preserve original line numbers across the elision
(preferred), or state the line range explicitly in the elision marker. Document
the choice in `ARCHITECTURE.md`.

**Done when:** an eval fixture asserts line numbers after an elision still
correspond to the source file.

### 1.6 — `CONTEXT.md` growth is unmanaged

Past the injection cap it silently truncates to the first N characters, so
later sections stop being injected with no warning outside `doctor`.

Fix: warn in `doctor` when approaching the cap, and make truncation
section-aware so whole sections drop rather than a sentence being cut mid-word.

**Done when:** a test asserts that an oversized `CONTEXT.md` yields whole
sections, never a partial one.

---

## Phase 2 — Make it trustworthy

**Gate:** CI green on a clean clone

### 2.1 — CI

`.github/workflows/test.yml`: matrix over Node 20 and 22, running `npm test`
and `npm run eval`. Both must be blocking.

### 2.2 — End-to-end hook tests

Current tests cover `src/prune/` only. Add tests that pipe realistic payloads
through each hook binary and assert the emitted JSON — including the fail-open
path (malformed input must exit 0 with no output).

### 2.3 — Cross-language eval fixtures

The three fixtures are synthetic JS/TS. Fidelity does not transfer across
languages. Add real captured output for at least Python (pytest), Go, and Rust
(cargo), each with `critical` patterns. Expect the `Bash` `keepMatching` regex
to need per-ecosystem work — pytest, cargo and go test format failures
differently.

### 2.4 — Run the benchmark and publish one honest number

Follow `bench/RUNBOOK.md` end to end on one task. Publish median, confidence
interval, success rate per arm, model, and fixture SHA. If the CI includes
zero, say so rather than quoting the median.

This is the task that decides whether the project is useful or just plausible.

### 2.5 — Contributor scaffolding

`CONTRIBUTING.md` (how to run tests, how to add an eval fixture, the
invariants), `CHANGELOG.md`, issue templates, and a GitHub repo description
plus topics. The repo currently has no description at all.

---

## Phase 3 — Scope expansion

Do not start until Phase 2's benchmark number exists. These are ordered by
expected value, and that ordering is a guess until there is data.

### 3.1 — Structure-aware pruning

Head/tail is a crude proxy for importance. For source files, a tree-sitter pass
that keeps imports, signatures, exports and type declarations while dropping
function bodies should dominate positional pruning. This is the largest
expected quality win in the project.

Gate it behind config, measure against the existing fixtures, and keep
positional pruning as the fallback for unparseable files.

### 3.2 — Config presets

`conservative` / `balanced` / `aggressive`, chosen with `ctxkeep init
--preset`. Pick the thresholds from benchmark data, not intuition.

### 3.3 — `ctxkeep report`

An HTML or terminal report over `metrics.jsonl`: savings over time, which tools
and paths dominate, expansion rate (how often the model follows a pointer — the
key signal for whether pruning is too aggressive).

Expansion rate is currently unmeasured and is the most useful missing metric.

### 3.4 — Multi-session memory benchmark

The current bench harness measures prune and dedupe only; a single-session task
rarely triggers compaction, so memory is untested. Design a task that spans a
compaction boundary and measure whether `CONTEXT.md` improves outcomes.

Until this exists, the memory feature is unproven.

### 3.5 — API proxy backend

The path to cross-agent support. `src/prune/` has no Claude Code dependency and
ports directly; hooks become one front-end over a shared core.

Only worth building after 2.4 shows the core mechanism works. Report each agent
against its own baseline, never a blended figure.
