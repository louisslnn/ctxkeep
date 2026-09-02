# ctxkeep — architecture guide

A walkthrough of what the project is, how the pieces fit, and where the edges
are. Read this before changing anything.

---

## 1. The one-paragraph model

Claude Code's context window fills up with three things: the conversation, the
system prompt, and tool results. In an agentic coding session the third one
dominates — a single `Read` of a large file or a verbose test run can outweigh
the entire conversation around it. ctxkeep sits in the agent lifecycle and does
three things: it **shortens tool results before they enter the context window**,
it **refuses redundant re-reads of unchanged files**, and it **persists the
knowledge that would otherwise be destroyed by compaction**. Everything else in
the repo is plumbing around those three ideas.

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
┌─ PreToolUse hook ──────────────────────────────────────────┐
│ hooks/pre-tool-use.js                                      │
│   Is this a Read?                    yes                   │
│   Is dedupe on?                      yes                   │
│   Was this path read this session?   look in session state │
│     → no  ▸ stay silent, let it through                    │
│     → yes ▸ has mtime changed since?                       │
│              → yes ▸ stay silent                           │
│              → no  ▸ DENY with a reason pointing at cache  │
└────────────────────────────────────────────────────────────┘
        │ (allowed)
        ▼
   Claude Code actually reads the file
        │
        ▼
┌─ PostToolUse hook ─────────────────────────────────────────┐
│ hooks/post-tool-use.js                                     │
│   extractText(tool_response)      → 700 lines of source    │
│   Is the tool on neverPrune?       no                      │
│   Is the path a cache file?        no                      │
│   pruneToolOutput(...)                                     │
│     ├ pick rule for "Read"       maxLines 400              │
│     ├ 700 > 400, so prune                                  │
│     ├ keep lines 0–99 and 660–699                          │
│     ├ stash all 700 lines → .ctxkeep/cache/toolu_X.txt     │
│     └ append the retrieval pointer                         │
│   record the read in session state (for dedupe)            │
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
  pre-tool-use.js  dedupe
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

## 5. The three mechanisms

### Mechanism 1 — Prune (the main lever)

**Hook:** `PostToolUse` → `updatedToolOutput`
**Applies to:** `Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, and MCP tools

Long tool results are shortened before they land in context. Head and tail are
kept, the middle is elided with a marker saying how much was removed, error-ish
lines are salvaged from the middle regardless of position, and the full text
goes to disk with a pointer appended.

This is where most of the saving comes from, because it targets the largest
thing in the window.

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

### Mechanism 2 — Dedupe

**Hook:** `PreToolUse` → `permissionDecision: "deny"`
**Applies to:** `Read` only

If a file was read this session and its mtime hasn't moved, the re-read is
denied with a reason explaining where the content already is. Partial reads
(with `offset`/`limit`) are exempt — those are a different request.

A denial costs a turn. Whether that turn is cheaper than the re-read depends on
file size and how the model responds. **This is the least-proven of the three
mechanisms**, which is why the benchmark isolates it in its own arm rather than
bundling it with pruning.

### Mechanism 3 — Memory

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

**The session state file races.** Claude Code runs tools in parallel. `readState`
→ mutate → `writeState` is a read-modify-write with no locking, so concurrent
`PostToolUse` hooks will clobber each other's entries. Effect: dedupe silently
misses some files. **Fixed in `b07c6ad` (task 1.2):** session state is now an
append-only log, one line per event, replayed by `readState`.

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

Still open: **the benchmark itself (task 2.4)** is blocked on a missing
`bench/RUNBOOK.md`/`run.js` (see `BENCH_PLAN.md`), so there is still no honest
end-to-end savings number. Until there is, treat the `eval/` percentages as what
the pruning *function* produces on fixtures, not as real-world savings.
