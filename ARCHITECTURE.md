# ctxkeep — architecture guide

A walkthrough of what the project is, how the pieces fit, and where the edges
are. Read this before changing anything.

---

## 1. The one-paragraph model

Claude Code's context window fills up with three things: the conversation, the
system prompt, and tool results. Tool results are a **meaningful minority** of
the window — measured across real sessions, roughly one fifth at its peak, not
the dominant term (§11.1). What actually dominates cost is the accumulated
conversation and the model's own reasoning, re-read from cache on every turn; a
single bulky `Read` or verbose test run is worth shaping mainly because trimming
it shrinks that re-read prefix for the rest of the session. So the lever is real
but bounded, and concentrated in the tail — the occasional oversized result, not
the median one. ctxkeep sits in the agent lifecycle and does three things: it
**shortens tool results before they enter the context window**, it **refuses
redundant re-reads of unchanged files**, and it **persists the knowledge that
would otherwise be destroyed by compaction**. Everything else in the repo is
plumbing around those three ideas.

---

## 2. Scope

### In scope

- Reducing tokens spent on tool results in Claude Code specifically
- Making that reduction reversible, so nothing is permanently lost
- Carrying durable project knowledge across compaction boundaries
- Measuring what it actually saves, honestly

### Explicitly out of scope

| Not this | Why |
|---|---|
| Other agents (Codex, Qwen, Aider) | Built on Claude Code hooks. No equivalent interception point elsewhere. A cross-agent version is an API proxy — a different project. |
| Rewriting conversation history | Breaks prompt caching. See §6. |
| Semantic retrieval / RAG over the repo | Different tool. ctxkeep shapes what the agent already asked for; it doesn't decide what to fetch. |
| Summarizing with an LLM | Would put a model call in the critical path of every tool call. See §5. |
| Replacing `CLAUDE.md` | That file already loads without running code. ctxkeep's memory is for what you *learn*, not what you *configure*. |

### The dividing line that shapes everything

**The hooks do mechanical work. The skill does judgment.**

Hooks are pure functions over text: count lines, keep some, drop others, write
a pointer. No model calls, no network, no judgment. They run on every tool call
and must be fast.

The skill is instructions given to Claude: when to expand a pruned result, how
to respond to a denied read, what qualifies as durable knowledge. Judgment
lives there because that's where it's free — Claude is already thinking.

Every time you're tempted to make a hook smarter, check whether the smartness
belongs in the skill instead.

---

## 3. Trace of a single tool call

This is the whole system in one sequence. Claude decides to read
`src/billing.js`, a 700-line file.

```
Claude emits Read(file_path: "src/billing.js")
        │
        ▼
   Claude Code reads the file
        │
        ▼
┌─ PostToolUse hook ─────────────────────────────────────────┐
│ hooks/post-tool-use.js                                     │
│   extractText(tool_response)      → 700 lines of source    │
│   Is the tool on neverPrune?       no                      │
│   Is the path a cache file?        no                      │
│   pruneToolOutput(...)                                     │
│     ├ pick rule for "Read"       maxLines 200              │
│     ├ 700 > 200, so prune                                  │
│     ├ keep lines 0–99 and 660–699                          │
│     ├ stash all 700 lines → .ctxkeep/cache/toolu_X.txt     │
│     └ append the retrieval pointer                         │
│   record the saving in metrics.jsonl                       │
│   emit updatedToolOutput                                   │
└────────────────────────────────────────────────────────────┘
        │
        ▼
Claude sees ~140 lines + "full result at .ctxkeep/cache/toolu_X.txt"
        │
        ▼
If it needs the elided middle, the SKILL tells it to Grep the
original path, or Read the cache file (exempt from pruning).
```

The two things to notice: **the full text is never destroyed**, and **the
decision to recover it belongs to Claude**, informed by the skill.

---

## 4. Module map

```
hooks/           lifecycle entry points — one file per event
  hooks.json       the wiring (which hook runs on which event/matcher)
  post-tool-use.js prune          ← the main lever
  session-start.js inject memory
  pre-compact.js   snapshot + optional gate

src/             the logic the hooks call
  io.js            stdin/stdout, response-shape probing, fail-open guard
  config.js        defaults + .ctxkeep.json merge
  prune/lines.js   the actual pruning algorithm
  prune/index.js   dispatch, caching, pointer construction
  memory.js        CONTEXT.md read/write/digest
  store.js         cache files, session state, metrics ledger
  tokenize.js      cheap token estimate

skills/ctxkeep/  the agent-facing half
bin/cli.js       init · doctor · stats · expand
eval/            fidelity + savings measurement on fixtures
test/            unit tests
```

### What each module owns

**`src/io.js`** — the boundary with Claude Code. Two jobs. First, parse the
hook payload and emit a response. Second, `extractText` / `replaceText`: the
shape of `tool_response` varies by tool and across versions, so these probe
several plausible shapes rather than assuming one. Also home to `guard()`,
which wraps every hook so failures become silent no-ops (§7).

**`src/config.js`** — one place where every tunable lives. Per-tool pruning
rules, the `neverPrune` list, `passthroughPaths`. Merged over `.ctxkeep.json`
if present. Malformed config degrades to defaults rather than breaking the
session.

**`src/prune/lines.js`** — the algorithm. Head/tail retention with a
`keepMatching` escape hatch. The core assumption: **the middle of a long
artifact is the least load-bearing part**. Top carries imports and signatures,
bottom carries results and the final error. `keepMatching` exists because that
assumption fails for command output — a failing assertion 180 lines into a
340-line test run is the entire reason the command was executed.

**`src/prune/index.js`** — decides *whether* to prune, stashes the original,
builds the pointer, does the token accounting. The pointer is the reason
pruning is safe; without it this is just deletion.

**`src/memory.js`** — owns `CONTEXT.md`. `buildDigest()` is the interesting
function: it strips the human-facing preamble, drops empty sections, caps at
the injection limit, and phrases the result as a factual statement rather than
an instruction (§6).

**`src/store.js`** — three separate persistence concerns that happen to share a
directory: the artifact cache (makes pruning reversible), session state (makes
dedupe possible), and the metrics ledger (makes measurement possible). All
best-effort; none of it is allowed to fail a hook.

**`src/tokenize.js`** — deliberately not a real tokenizer. A hook spawns a
process on every tool call, so loading a BPE vocabulary would cost more latency
than the pruning saves. Character-ratio heuristic, honest about being one.

---

## 5. The two mechanisms

A third mechanism, read-dedupe, was removed after two rounds of measurement —
see §12 for the evidence and reasoning.

### Mechanism 1 — Prune (the primary mechanism, a bounded lever)

**Hook:** `PostToolUse` → `updatedToolOutput`
**Applies to:** `Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, and MCP tools

Long tool results are shortened before they land in context. Head and tail are
kept, the middle is elided with a marker saying how much was removed, error-ish
lines are salvaged from the middle regardless of position, and the full text
goes to disk with a pointer appended.

This is the only token-savings lever, but "primary" is not "big": tool
output is ~1/5 of the window and only its tail is bulky enough to prune, so the
realistic gain is modest and lives in the occasional oversized result (§11.1).
`Bash` output specifically almost never crosses its threshold — agents pipe
through `grep`/`tail` — so Bash pruning moves ~0.08% of tool bytes; its
`keepMatching` regex earns its keep as fidelity insurance on the rare prune, not
as a savings lever (§11.2).

**Why it's safe:** reversible. **Why it might not be:** the model has to
correctly judge when to expand. That judgment is what the skill teaches, and
it's the part most likely to need tuning.

The pruned text must be handed back in the tool's *own* `tool_response` shape,
not as a bare string. `Read`'s shape is nested (`file.content`); early on
`replaceText` returned a bare string for it, which Claude Code silently dropped,
so Read pruning ran but never reached the model (see §8). `replaceText` now
mirrors `extractText` for every shape.

#### Line numbers across an elision (task 1.5)

A `Read` result is line-oriented: a model may reason about line *positions* in a
file, and a downstream `Edit` or a note like "the bug is near line 840" depends
on those positions being true.

The subtlety, confirmed against a real captured payload
(`test/fixtures/payloads/read.json`): the `tool_response` a hook receives carries
the file's **raw content, without the `1→`, `2→` gutter** — Claude Code's
renderer adds that gutter *after* the hook runs. So if ctxkeep elides the middle
and hands back head+tail, the renderer renumbers the survivors sequentially from
1 and every tail line is labelled far below its true source position: silent
drift.

**Decision: name the original source line range in each elision marker**, e.g.
`… 760 lines elided … (original lines 101-860)`. The head is always source lines
`1..headLines`; each marker states exactly which source lines it replaces; so the
first surviving tail line's true number is one past the last marker's range, and
every kept line's position is recoverable from the text itself, independent of
the renderer. This was chosen over rewriting each surviving line with an explicit
`N→` prefix, which risks double-numbering against the renderer's own gutter and
is a larger, shape-dependent change. When `keepMatching` salvages error lines out
of the middle, the elision splits into several gaps, each reporting its own
range. Asserted by the `read-line-numbers` eval fixture and
`test/lines-elision.test.js`.

### Mechanism 2 — Memory

**Hooks:** `PreCompact` (save) + `SessionStart` (restore)

`CONTEXT.md` at the project root holds four sections: Decisions, Constraints,
Ruled out, Open threads. `SessionStart` fires on `startup`, `resume`, `clear`,
`compact` and `fork`, and injects the non-empty sections via `additionalContext`.
The `compact` case is the point of the whole thing — it fires right after
compaction discarded the conversation.

**"Ruled out" is the highest-value section.** Without it, every fresh context
walks confidently into the same dead ends you already paid to discover.

Note the split: **hooks never write memory, Claude does.** Deciding what counts
as durable is judgment, so it lives in the skill. The hooks only snapshot the
transcript and restore what was written.

---

## 6. Invariants

Rules that hold across the codebase. Breaking one usually looks fine locally
and causes a subtle problem elsewhere.

**Never rewrite history.** Prompt caching keys on an exact prefix. Pruning a
turn already in context invalidates everything after it, forcing a full re-send
at uncached rates — which can cost more than the pruning saves. ctxkeep only
shapes content on the way *in*. If you ever add a "clean up old turns" feature,
this is the invariant it will break.

**Pruning must be reversible.** Every prune stashes the original and emits a
pointer. A prune without a pointer is data loss.

**Cache reads are never pruned.** `passthroughPaths` exempts `.ctxkeep/`. Without
it, expanding a pruned artifact prunes the expansion, and the model loops.

**Fail open, always.** §7.

**Hook output is capped at 10,000 characters.** Including `additionalContext`.
Over the cap, Claude Code writes to a file and passes a preview plus path — it
works, but costs a round trip. `ctxkeep doctor` reports your injection size.

**Injected context is phrased as statements, not instructions.** Text that reads
like an out-of-band system command can trip prompt-injection defenses and get
surfaced to the user instead of used. Compare: "Accumulated context for this
project, recorded in previous sessions:" versus "IMPORTANT: You must follow
these rules."

**Report estimates as estimates.** The token counts are a heuristic. Anywhere a
number reaches a human, it says so.

---

## 7. Failure philosophy

A hook runs on every tool call. If it throws, hangs, or prints malformed JSON,
the user's session degrades. **The failure mode of a context optimizer must
never be "Claude Code stopped working."**

So every entry point is wrapped in `guard()`, which catches everything, exits 0,
and emits nothing — which Claude Code reads as "this hook has no opinion." There
is also a 5-second self-kill timer. `CTXKEEP_DEBUG=1` surfaces errors to stderr
for debugging.

The consequence: **a broken ctxkeep looks like no ctxkeep.** You will not get an
error, you will get zero savings. That's why `ctxkeep doctor` exists and why the
benchmark preflights before spending quota.

---

## 8. Known defects and gaps

Found while writing this guide. Phase 1 resolved the confirmed defects — each is
tagged below with the commit that fixed it. Two more surfaced later: the
`replaceText` Read drop (found empirically in Phase 2) and the structural-pruning
gap, which is a direction rather than a bug.

**`startedAt` is read but never written.** `hooks/pre-compact.js` checks
`state.startedAt ?? 0` to decide whether `CONTEXT.md` was touched this session,
but nothing ever sets it. The comparison is always against epoch, so
`touchedThisSession` is true whenever the file exists at all — meaning
`blockCompactUntilRecorded` **never fires**. The feature is dead code.
**Fixed in `19d09b9` (task 1.1):** `SessionStart` stamps `startedAt`.

**The session state / metrics files race.** Claude Code runs tools in parallel.
A `readState` → mutate → `writeState` cycle with no locking lets concurrent hooks
clobber each other's entries — silently losing recorded events (and, at the time,
the reads dedupe depended on). **Fixed in `b07c6ad` (task 1.2):** the log is now
append-only, one line per event, replayed by `readState`; the metrics ledger
appends the same way. (Dedupe itself was later removed — §12 — but the
append-only design still guards the ledger.)

**The artifact cache is never garbage collected.** Every pruned result writes a
file to `.ctxkeep/cache/` forever. A long-lived project will accumulate
thousands. **Fixed in `d9b4160` (task 1.3):** age-based `sweepCache` on
`SessionStart` (retention `config.cache.retentionDays`, default 7), never on the
`PostToolUse` hot path.

**Line-number drift after pruning.** `Read` results carry line numbers. Eliding
the middle leaves a gap in the sequence, so a model reasoning about line
positions in a pruned file can be wrong. `str_replace` edits are string-based
and unaffected, but anything line-oriented is exposed. **Fixed in `44de712`
(task 1.5):** each elision marker names the original source line range it stands
in for — see §5, Mechanism 1.

**`tool_response` shape is unverified.** `extractText` probes several plausible
shapes because the real one wasn't confirmed against a live session. This is the
first thing to check — everything downstream depends on it. **Fixed in `71e7a3e`
(task 1.4):** real payloads for Read, Bash, WebFetch and an MCP tool were
captured under `test/fixtures/payloads/`, and `extractText` was narrowed to the
observed shapes while keeping the fallback.

**`CONTEXT.md` growth is unmanaged.** Nothing prunes it. Past the injection cap
it silently truncates to the first N characters, meaning later sections stop
being injected with no warning beyond `doctor`. **Fixed in `08dc9b5` (task
1.6):** truncation is section-aware (whole sections drop, never a sentence cut
mid-word) and `doctor` warns as the cap approaches.

**`replaceText` dropped Read pruning end-to-end.** `extractText` read the Read
shape from `file.content`, but `replaceText` had no matching branch and returned
the pruned text as a bare string — which Claude Code silently ignored. So for the
most-pruned tool, the hook ran, stashed the original, and recorded a saving in
`metrics.jsonl`, while the model received the full untouched file; fail-open hid
it. Confirmed empirically (an 800-line Read came back untouched before the fix,
pruned after). **Fixed in `14667e4`:** `replaceText` round-trips the Read shape,
mirroring `extractText`. Caveat: the internal `metrics.jsonl` savings for Read
before this commit counted bytes that never reached context.

> **What this bug means for the test strategy.** A total failure of the primary
> code path — Read, the most-pruned tool — survived 36 unit tests and 7 eval
> fixtures. It survived because *every one of those is a function-level test*:
> they call `pruneToolOutput`/`replaceText` or spawn a hook and assert the JSON
> it **emits**. Not one observed what Claude Code **delivers** to the model after
> applying `updatedToolOutput`. That gap is structural, not an oversight: whether
> a hook's emitted shape is accepted is behaviour of the live harness, which a
> hermetic, deterministic, network-free suite (the thing CI must be) cannot
> reproduce. So a class of bug — the hook emits a shape Claude Code silently
> drops — is *invisible* to `npm test` by construction, and fail-open guarantees
> it surfaces as zero savings, never an error. The mitigation is an explicit
> out-of-band delivery check (`test/delivery-check.sh`, run against a live
> `claude`) plus the manual procedure in `CONTRIBUTING.md`. A future change to
> what any hook emits must be verified there, not only in `test/`. Treat a green
> `npm test` as "the function is correct", never as "the model received it".

**Pruning is positional, not structural.** Head/tail is a crude proxy for
importance. A structure-aware version — keep signatures and exports, drop
bodies — would almost certainly do better on source files. That's the most
promising direction for a v2 (TASKS.md 3.1). Still open.

---

## 9. Where to extend

Roughly in order of expected value:

1. ~~**Fix the defects in §8.**~~ Done in Phase 1 (and the `replaceText` Read
   drop in Phase 2); see §8 for the fixing commits.
2. **Structure-aware pruning for source files.** Tree-sitter, keep the
   skeleton, drop bodies. Bigger win than any tuning of head/tail counts.
3. **More eval fixtures from your own repos.** The current three are synthetic
   and tuned for JS/TS. Fidelity numbers don't transfer across languages.
4. **Cache GC.**
5. **The API-proxy backend**, if cross-agent support matters. `src/prune/` has
   no Claude Code dependency and ports directly; the hooks become one front-end
   over a shared core.

Before any of these, get a real benchmark number on one task. Optimizing a
system you haven't measured is how you end up with a very fast 3% improvement.

---

## 10. Hardening status (Phase 2)

The mechanism works; Phase 2 is about being able to trust it.

- **CI** (`9369d14`, task 2.1): GitHub Actions runs `npm test` and `npm run
  eval` on Node 20 and 22, both blocking.
- **End-to-end hook tests** (`86db4c9`, task 2.2): each hook binary is driven
  with realistic payloads, including the fail-open path — malformed input,
  missing config, and an unwritable cache directory each exit 0 with no output.
- **Cross-language eval fixtures** (`551beef`, task 2.3): real captured pytest,
  `go test` and cargo output. `go test` interleaves failures through a run, so
  the `Bash` `keepMatching` regex gained `\bFAIL\b` and `_test\.go:\d+:` to keep
  them inline; pytest and cargo group failures at head/tail already.
- **Contributor scaffolding** (`ac68621`, task 2.5): `CONTRIBUTING.md`,
  `CHANGELOG.md`, issue templates.
- **The `replaceText` Read fix** (`14667e4`): see §8 — the pruning path that
  mattered most had never reached the model.

Still open: **the benchmark itself (task 2.4).** The harness now exists —
`bench/RUNBOOK.md`, `bench/run.js`, `bench/report.js` and task specs under
`bench/tasks/` — so the earlier blocker is gone. But **`bench/run.js` has never
been run: there is no end-to-end, session-level savings number.** What has been
measured is the *mechanism*, not the outcome — four manual `claude -p`
calibrations and a 699-`tool_result` payload sweep (`bench/analyze-payloads.js`;
see §11 and `BENCH_PLAN.md`), which characterise how much there is to prune, not
what a real session bills. Until the matrix runs, treat the `eval/` percentages
as what the pruning *function* produces on fixtures, not as real-world savings.

---

## 11. What the measurements overturned

Two of this document's load-bearing claims — §1's "tool results dominate the
context window" and §5's framing of pruning as "the main lever" — were written
before anything was measured. `bench/analyze-payloads.js` (699 real
`tool_result`s) and `bench/analyze-context-share.js` (per-session usage from the
same transcripts) now say otherwise. The claims are corrected in §1 and §5; the
evidence is recorded here so the correction isn't just an assertion swapped for
another.

**Independently replicated.** Q1–Q3 below were derived twice — by two agents
running concurrently on this branch in **separate sessions with no shared
context**, from the same transcripts. They reached identical conclusions and
numbers: Read→200 as the net-savings knee with **zero** net-negative prunes,
tool output at ~1/5 of the peak window, Bash pruning at 0.08%, `keepMatching`
kept as fidelity insurance, and no minimum-elision floor. The second session
made no commits and reverted its own edits, so the tree is unaffected. Two
independent measurements agreeing is replication, not a single reading — treat
the findings below as reproduced, not as one analyst's take.

### 11.1 Tool output does not dominate the window (Q1)

Per session, tool output measured against the size of the context window at its
**peak** (the largest single-request prefix — an upper bound on tool output's
share, since a no-compaction session accumulates every result):

| denominator | tool-output share |
|---|---|
| peak context window (per session) | **12–35%, median ~18–20%** |
| total **billed** input tokens (incl. cache re-reads) | **0.2%** |

Tool output is a **meaningful minority of the window — roughly one fifth — not
the dominant term.** The largest thing in the window is the accumulated
conversation and the model's own reasoning, re-read from cache every turn: across
these sessions billed input was **~178M tokens**, of which cache-read (the prefix
re-read) is the overwhelming majority and tool output is 0.2%. So the real cost
driver is prefix size × turns, not the one-time cost of any single result.

That does not make pruning worthless — a smaller prefix is re-read more cheaply
for the rest of the session, so trimming a bulky result compounds. But its
leverage is bounded by tool output's ~1/5 share of the window, and only the
**tail** of that (the occasional bulk read / giant artifact) is bulky enough to
prune at all. This is the same conclusion the four calibrations reached from the
other direction (BENCH_PLAN §6): the payoff is real but modest and concentrated
in the tail.

### 11.2 Bash error-salvage: keep the mechanism, drop the "load-bearing" story (Q2)

`bench/analyze-payloads.js` sweep: **Bash pruning moves 0.08% of tool bytes at
any threshold** (120/80/60 lines). It is not a savings lever and this document
should never have implied it was. A well-behaved agent pipes command output
through `grep`/`tail`, so almost nothing crosses the Bash threshold in the first
place.

But `keepMatching` was never a savings feature — it is **correctness insurance on
the rare Bash prune that does fire.** When a 340-line failing test run *is*
pruned, the head/tail window can bury the one failing assertion in the elided
middle; `keepMatching` salvages it. The cost is a few regex alternatives run only
on already-pruned Bash output — negligible — and the downside of removing it is
exactly the fixture-losing failure the `CONTEXT.md` constraint records from the
first eval run. The `go test` additions (`\bFAIL\b`, `_test\.go:\d+:`, task 2.3)
target the one common runner that interleaves failures mid-run, where the risk is
highest.

**Recommendation: keep the mechanism as-is; fix the narrative.** Stop presenting
Bash pruning as load-bearing (here and in §4/§5); document `keepMatching` as
cheap fidelity insurance on a rare path, which is what the data supports.

### 11.3 A minimum-elision floor is not worth adding (Q3)

The fixed retrieval pointer costs **~54 heuristic tokens**, charged to every
prune regardless of how much was elided. The worry: near the threshold a prune
might save so little that the pointer eats the gain, and the prune becomes a
re-fetch candidate with almost no upside. Measured across the real Read results
that prune at the new 200-line rule:

| net saved / prune (tokens) | min | p25 | median | p90 | max |
|---|---|---|---|---|---|
| | **662** | 1,032 | 1,551 | 9,519 | 21,852 |

**Zero prunes net ≤ 0**, and the *smallest* still nets 662 tokens — the 54-token
pointer is at most ~8% of the gain even at the low end. A floor sweep (skip when
projected net saving < F) skips **nothing** until F≈800, and F=800 would forgo
only 2.2k of 53.8k total savings to drop 3 prunes. So a floor would add a second
tunable and a config surface for **no measurable benefit**.

The reason is that `maxLines` already *is* the floor: once a Read exceeds 200
lines, head(100)+tail(40) elides ≥60 lines, and 60 lines of code
(~11 tokens/line) dwarfs a 54-token pointer. **Recommendation: do not add a
floor.** Revisit only if `maxLines` is ever pushed down near the 140-line
head+tail sum, where the smallest prunes would start approaching the pointer
cost. Reproduce with `node bench/analyze-context-share.js`.

---

## 12. Read-dedupe was removed

Dedupe denied a `Read` whose lines had already been delivered this session, on
the theory that a denial (one turn) is cheaper than re-delivering the bytes. Two
rounds of measurement said otherwise, and it was removed rather than kept on the
strength of a maybe.

**The evidence.**

- **Round 1 — four single-bug calibrations: it fired 0 times.** Competent agents
  don't re-read byte-identical files; they grep and offset-read. The original
  call-identity design (path + mtime, offset reads exempt) never matched.
- **Round 2 — a file-identity redesign (content hash + union of delivered line
  ranges) finally made it fire on wide exploratory work — and it was
  net-negative.** On the eslint shake-out's `on` arm it fired 7 times; **3 of
  those denials were routed around** by the agent re-reading the same path via a
  shell `cat`/`sed`, which cost a turn and delivered the bytes anyway. Net saving
  collapsed to 2,151 / 1,863 / **0** heuristic tokens across the three runs.

**Why it cannot reliably beat zero — the structural argument.** A denial only
wins if the agent did *not* actually need those lines and would not route around.
Distinguishing a wasteful re-read from a needed one is a **judgment call**, and
invariant 7 (§6) bars judgment from hooks. A mechanical hook can only ask "were
these exact lines delivered before," which is orthogonal to whether the model
needs them *now* — so it will keep denying needed re-reads, the agent routes
around, and it is net-negative *exactly when it fires*. Meanwhile it paid to hash
the whole file on **every** `Read` (`PreToolUse` on the hot path) to occasionally
lose tokens. A mechanism that costs latency on every read to sometimes lose
tokens is worse than nothing.

**It also conflicted with pruning.** A pruned Read records its *requested* range
as delivered, but the model only ever saw head+tail — the middle was elided to
disk. Dedupe would then deny a re-read of the very lines pruning had hidden,
pointing the model at the cache pointer it was already free to follow. The two
mechanisms fought over the same range. (Observed live while editing this repo,
which dogfoods its own hooks.)

**What was removed:** `hooks/pre-tool-use.js` (the whole hook) and its
`PreToolUse` registration; `src/dedupe.js`; the read-recording and route-around
tracking in `hooks/post-tool-use.js`; the `reads`/`denials`/`compactedAt` state
in `src/store.js` and the `compact`-time stamp in `session-start.js`; the
`dedupe` config block; the `dedupe`/`dedupe_routed`/net-dedupe reporting in
`ctxkeep stats`; and the third benchmark arm (`bench/run.js` is now a straight
off/on comparison). `readState` survives for `startedAt` and the compaction gate.

**What would change the verdict** (none of it cheap enough to justify now): a
signal that separates wasteful from needed re-reads *without* model judgment —
which does not obviously exist — or evidence that re-reads dominate cost on some
real workload. Q1 (§11.1) bounds that ceiling: tool output is ~1/5 of the window,
and re-reads are a fraction of that. The prune lever already captures the bulky
tail; dedupe was chasing the remainder and losing turns to do it.
