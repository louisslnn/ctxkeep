# ctxkeep

Context and token management for Claude Code.

Three mechanisms, each hooked into a different point in the agent lifecycle:

| What | Where | Status |
|---|---|---|
| Prune bulky tool results before they enter context | `PostToolUse` → `updatedToolOutput` | Works; measured on the mechanism, not yet end-to-end |
| Deny re-reads of unchanged files | `PreToolUse` → `permissionDecision` | Implemented, **untested** — never fired in a benchmark |
| Persist and restore project memory across compaction | `PreCompact` + `SessionStart` | Implemented, **untested** — no benchmarked session has compacted |

Pruning is reversible: every shortened result carries a pointer to the full
text on disk, and the bundled skill teaches Claude when to follow it.

## What it does, and what's been measured

Read this before installing.

**What pruning actually does.** It shrinks the tool output in the *prefix* that
Claude Code re-reads from cache on every subsequent turn — not the biggest line
item on your bill. Measured across real sessions (699 tool results over 12
transcripts): tool output is **~1/5 of the peak context window** (median
~18–20%) and **~0.2% of total billed input tokens**. The bill is dominated by
*prefix size × turns* — the accumulated conversation and reasoning re-read every
turn — not by any single result. Trimming a bulky result compounds (a smaller
prefix is re-read more cheaply for the rest of the session), but the ceiling on
that is tool output's ~1/5 share, and only the **tail** of it — the occasional
bulk read or giant artifact — is large enough to prune at all.

**There is no end-to-end savings number yet.** `bench/run.js` exists but has
never been run. Everything measured so far is the *mechanism*: the `eval/`
fixtures below (does pruning elide and preserve correctly) and a payload
distribution sweep — not a real session's cost. See
[`bench/RUNBOOK.md`](bench/RUNBOOK.md) for how a session-level number would be
produced, and `ARCHITECTURE.md` §11 for the measurements.

**Dedupe and memory are implemented but untested.** Dedupe fired **zero** times
across four calibration runs — agents rarely re-read a byte-identical file.
Memory never triggered because no benchmarked session reached compaction. Both
may help on longer or multi-session work; that is unproven here.

So, deciding whether to install:

- ✅ Green: pruning elides and preserves correctly on fixtures (`npm run eval`,
  0 critical patterns lost), fails open, and is reversible.
- ⚠️ Red: no end-to-end savings number; dedupe and memory have never been
  exercised.
- Realistic upper bound on prune savings: bounded by tool output's ~1/5 share
  of the window, and in practice the tail of that — meaningful on
  exploration-heavy sessions, negligible on short ones.

## Install

ctxkeep installs from source and has no runtime dependencies. Clone the
repository, then install the CLI from the checkout:

```bash
npm install -g .
```

That puts the `ctxkeep` command on your PATH. Then, inside each project you want
ctxkeep to manage:

```bash
ctxkeep init
ctxkeep doctor
```

`init` writes the hooks into `.claude/settings.json` and creates `CONTEXT.md`;
`doctor` verifies the wiring and reports what will be injected. Restart Claude
Code after `init` so the hooks load — `doctor`'s "hooks have fired at least
once" check stays red until a session has run against a real large-file read.

## Verify this first

The exact shape of `tool_response` in the `PostToolUse` payload varies by tool
and has changed across Claude Code versions. `src/io.js` probes the plausible
shapes rather than assuming one, but before you tune anything, confirm what
your version actually emits:

```bash
# Add a throwaway logging hook, run one session, then read the capture.
echo '{"hooks":{"PostToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"cat >> /tmp/ctxkeep-shapes.jsonl"}]}]}}' \
  > .claude/settings.local.json
```

Everything downstream depends on getting this right.

## Layout

```
bin/cli.js              init · doctor · stats · expand
hooks/
  hooks.json            plugin manifest — the wiring
  post-tool-use.js      prune (shrinks the re-read prefix)
  pre-tool-use.js       dedupe unchanged re-reads
  session-start.js      re-inject memory on start/resume/compact/fork
  pre-compact.js        snapshot transcript, optional memory gate
src/
  config.js             defaults + .ctxkeep.json
  io.js                 stdin/stdout plumbing, fail-open guard
  prune/                pruning strategies per tool
  memory.js             CONTEXT.md read/write/digest
  store.js              artifact cache, session state, metrics ledger
  tokenize.js           cheap token estimator
skills/ctxkeep/         the agent-facing half
eval/harness.js         savings AND fidelity measurement
```

## Configuration

Optional `.ctxkeep.json` at the project root, merged over the defaults in
`src/config.js`:

```json
{
  "prune": {
    "Read": { "maxLines": 200, "headLines": 100, "tailLines": 40 },
    "Bash": { "maxLines": 120, "headLines": 30, "tailLines": 60 }
  },
  "dedupe": { "enabled": true },
  "memory": { "file": "CONTEXT.md", "blockCompactUntilRecorded": false }
}
```

`blockCompactUntilRecorded` blocks the first compaction of a session if
`CONTEXT.md` hasn't been touched, so Claude records what it learned first. It
fires at most once per session by design — a gate that can retrigger will wedge
a session against a full context window.

## Evaluate before you tune

```
npm run eval
```

Savings alone are a meaningless metric; you can hit any compression number by
deleting more. Each fixture declares `critical` patterns that must survive, and
the harness reports them alongside the savings:

These numbers measure the **pruning function** — `pruneToolOutput`'s return
value — over the synthetic fixtures in `eval/fixtures/`, not real Claude Code
sessions. They are **not** a real-world savings claim; your mileage depends
entirely on what your tools actually emit. And a green eval only proves the
function elides and preserves correctly — it does **not** prove the shortened
result is actually delivered into the context window. That end-to-end path is a
separate concern (the `replaceText` Read drop hid behind green eval numbers once
already) and is verified separately by `test/delivery-check.sh`. See
ARCHITECTURE.md §8. A session-level savings number is a further step again —
produced by running the matrix in [`bench/RUNBOOK.md`](bench/RUNBOOK.md), which
has not been run.

```
fixture                     before   after   saved   inline  lost
-----------------------------------------------------------------
bash-cargo-test-failure       1.8k     959     46%      4/4     0
bash-go-test-failure          2.9k    1.0k     64%      4/4     0
bash-pytest-failure           3.4k    1.7k     50%      4/4     0
bash-short-passthrough          21      21      0%      2/2     0
bash-test-run-failure         2.5k    1.3k     47%      4/4     0
read-large-source            35.0k    2.0k     94%      3/3     0
read-line-numbers             4.7k     744     84%      4/4     0
-----------------------------------------------------------------
TOTAL                        50.2k    7.8k     85%    25/25     0
```

`lost` above zero is a bug. On its first run this harness caught one: the
error-preservation regex used `\berror\b`, which silently fails to match
`AssertionError` because the word boundary falls inside the CamelCase name. A
buried test failure was being pruned away. Add fixtures from your own repo —
the defaults are tuned for JS/TS output and will not transfer cleanly.

## Design constraints worth knowing

**Never rewrite history.** Prompt caching keys on an exact prefix. Pruning a
turn already in context invalidates everything after it and costs more than it
saves. ctxkeep only shapes content on the way *in*.

**10,000 characters.** Hook output strings, including `additionalContext`, are
capped. Past that, Claude Code writes to a file and passes a preview plus path —
workable, but a wasted round trip. `ctxkeep doctor` reports your injection size.

**Fail open.** A hook runs on every tool call. Every entry point swallows its
own errors and exits 0, which reads as "no opinion". The failure mode of a
context optimizer must never be a broken session. Set `CTXKEEP_DEBUG=1` to
surface hook errors in the transcript.

**Factual phrasing.** Injected context is written as statements, not
instructions. Text that reads like an out-of-band system command can trip
prompt-injection defenses and get surfaced to the user instead of used.

**Token counts are estimates.** A character-ratio heuristic, not a real
tokenizer — loading a BPE vocabulary in a hook that spawns on every tool call
would cost more latency than the pruning saves. Directionally right, not exact.

## Two halves

The hooks do the mechanical work: no model judgment, no LLM calls, no latency
beyond a Node process spawn. The skill (`skills/ctxkeep/SKILL.md`) does the part
that needs judgment: when to expand a pruned artifact, how to respond to a
dedupe denial, what qualifies as durable knowledge.

Keep that boundary. Every piece of judgment you move into the hooks becomes a
model call in your critical path, on every tool call, forever.

## License

MIT
