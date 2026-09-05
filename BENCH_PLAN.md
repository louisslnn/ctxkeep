# BENCH_PLAN.md — preparation for TASKS.md 2.4 (benchmark)

Status: **Fixture selection rebuilt. No fixture is matrix-ready yet.** The
original fixture (validator.js) was calibrated and then **rejected** — a
competent agent solves it without loading anything bulky, so there is nothing
to prune. A second, deliberately harder fixture (prettier) was built and
calibrated to test the reframed hypothesis; it also returned **prune count 0**,
and that run was confounded by a construction leak. `bench/run.js` has **not**
been run — no matrix quota spent. Details in §0 and §5.

---

## 0. Fixture selection, rebuilt (2026-09-04)

### 0.1 Why validator.js was rejected

The fix-isvat-es fixture was calibrated with one manual `claude -p` run
(sonnet-4-6, SHA a32b22e): **12 turns / 136s / $0.235**, success. But the
transcript showed the fixture has **nothing worth pruning**:

- Total tool output across the whole task: **~11.1 KB**; largest single result
  **5.5 KB** (a `Read` of the 140-line buggy `isVAT.js` — under the 400-line
  Read threshold).
- The 16,231-line `validators.test.js` was **not** bulk-read: the agent grepped
  for the failing case's line number, then did an **offset-limited** `Read`
  (`offset 15570, limit 40`).
- All `npm test` runs were piped through `grep`/`tail`, so no Bash result
  approached the 120-line threshold.

**The reason matters more than the rejection:** a competent agent already
self-limits context. It greps for a symbol and offset-reads the hit rather than
loading whole files, so on a task whose bug is findable by grepping an obvious
symbol, nothing bulky ever enters the window and ctxkeep has no surface to act
on. The benchmark's real question is therefore **where an agent *fails* to
self-limit**, and whether that region is large enough to measure.

### 0.2 New candidate criteria + screening (byte size on a failing suite)

Selection was rebuilt around four conditions, each candidate meeting ≥2:
(a) cause not findable by grepping an obvious symbol → must read to build a
mental model; (b) failing suite emits verbose output (hundreds of lines) →
where Bash pruning would earn its keep; (c) failing test points at one module,
cause lives in another; (d) same files re-read across many turns → the only
condition dedupe acts under.

Three candidates were cloned and their failing-suite output measured
(`--ignore-scripts` installs, sandbox off; network reaches GitHub/npm only with
the sandbox disabled):

| Repo | Failing state | # fails | Raw bytes | Raw lines | Crosses 120-line Bash threshold? |
|---|---|---|---|---|---|
| validator.js *(prior)* | 1 | 1 | agent self-limited to ~30 lines | — | **No** — trivially greppable |
| eslint | revert real fix src | 1 | 6,210 | 178 | Yes, but ~150 lines are passing `✔` spec-reporter noise; diagnostic is compact/greppable |
| date-fns v2.30 | crude src bug | 10 | 10,567 | 319 | Inflated by 10 fails; per-failure ≈30 lines → a clean 1-fail fixture lands near/under 120 |
| **prettier** | revert real fix src | 68 | **53,934** | **1,446** | **Yes, decisively** — ~20 lines/snapshot diff the agent must *read*, not greppable |

date-fns also accrued install friction (HEAD is a monorepo-in-migration with no
top-level `test`; v2.30's `@date-fns/date-fns-scripts` devDep is unpublished →
`npm install` 404s; its `npm test` is a browser `karma start`). It remains only
a possible (c)+(d) dedupe shape, not a headline candidate.

**Prettier was the strongest** and was carried forward.

### 0.3 Finding: criterion (b) is in tension with a clean single-cause fixture

The 1,446-line prettier dump above required **68 same-cause failures** (a broad
4-file source revert). RUNBOOK forbids that shape — it wants ~one failing test.
When the prettier fixture is built cleanly (revert one file → the two intended
`arrow-chain` failures), the **full** failing suite prints only **102 lines**,
and the scoped run ~46–80. So verbose failure output only materialises under
many failures, which a well-formed single-root-cause fixture specifically
avoids. **This is a finding about the benchmark design, not a fixture problem:**
the "verbose Bash output" lever cannot be exercised without violating the
one-failure rule. A clean fixture's pruning surface, if any, has to come from
criterion (a) — large *source* the agent is forced to read — not from (b).

---

## 1. Candidate fixture repos (RUNBOOK step 1 criteria)

The RUNBOOK requires all four of: a fast, deterministic test suite (<~60s, no
network, no flakes); enough size (>~5k LOC) that finding a bug means exploring
several files; an offline-capable install after the first fetch; and a history
of real bug-fix commits that touched both source and a test.

### A — `validatorjs/validator.js` (MIT) — **chosen, constructed below**
- **Size / exploration:** 6,158 LOC across ~100 isolated `src/lib/isX.js`
  validator modules. The buggy file is one of a hundred, so a prompt that names
  only the failing *test* forces genuine exploration — the strongest `Read` +
  `Grep`/`Glob` surface of the three.
- **Suite:** mocha, 323 tests, ~185ms, fully deterministic across repeated runs,
  no network.
- **History:** a steady stream of localized `fix(isX): …` commits, each touching
  one `src/lib` file plus `test/validators.test.js` — ideal SWE-bench-style
  material.
- **Wrinkle (documented, not blocking):** no committed lockfile, and an old
  `rollup@0.47` peer-dep conflict in the *browser-build* tooling. `npm ci` can't
  run (no lock) and plain `npm install` hits ERESOLVE; install with
  `npm install --legacy-peer-deps`. The test path (mocha / @babel/register /
  chai) is unaffected, and the tree is deterministic once installed.

### B — `date-fns/date-fns` (MIT)
- **For:** hundreds of small single-purpose modules → strong **dedupe** surface
  (the agent re-reads neighbouring helpers while fixing one function) and many
  `Grep`/`Glob` hits; deterministic jest tests; a one-function bug with a single
  failing test is easy to lift from history.
- **Against:** individual files are small, so `Read` pruning bites less than in
  validator.js; heavier install. Best held as a dedicated **dedupe** fixture,
  the second task shape.

### C — `micromatch/picomatch` (MIT)
- **For:** glob parse/match logic spread across a few files → real exploration
  with a different code shape (parser state, not flat validators); deterministic
  mocha suite, fast, no network; clean fix-commit history touching src + test.
- **Against:** smaller than validator.js, so the (2) "several files" bar is only
  just met; a good **control / second-shape** fixture rather than the headline.

**Recommendation:** headline number on **A (validator.js)**; add **B** later as
the dedupe-focused shape and **C** as a lower-variance control. The RUNBOOK's
step 5 says to run three or four task shapes before generalising — A/B/C are
that set.

---

## 2. Top candidate — construction (done)

Built per RUNBOOK step 1, "Constructing the task state".

- **Repo:** `validatorjs/validator.js`, cloned to `/Users/louissalanon/bench-fixture`.
- **Install:** `npm install --legacy-peer-deps` (see wrinkle above).
- **Fix commit chosen:** `a79ff98` — `fix(isVAT): accept Spanish digit controls`.
  It changes `src/lib/isVAT.js` (2 lines, the `ES` locale regex) plus the test,
  and its added cases extend a **single** `it('should validate VAT numbers')`
  block, so the pre-fix state yields exactly one failing test.
- **Fixture commit (the `commit` value):**
  `a32b22e7ba9f5e6f54799d5578017fbbdceb1208`
  — `git checkout -b bench-fixture a79ff98^` (pre-fix whole tree), then
  `git checkout a79ff98 -- test/validators.test.js` (fix's test brought
  forward), committed.

### Validation (RUNBOOK step 1, "Validate before going further")

- **Exactly one test fails**, for the intended reason:
  `Validators > should validate VAT numbers` —
  `validator.isVAT("ESA28015865", "ES") failed but should have passed`.
  Suite: **322 passing / 1 failing**.
- **The fix is in source, not the test.** Applying `a79ff98`'s `src/lib/isVAT.js`
  alone (test file untouched) turns the suite **323 passing / 0 failing**.
  Restoring the pre-fix source returns it to 322/1. Reconfirmed across repeated
  runs — deterministic.
- Root cause is a source-level regex in the large multi-locale `isVAT.js`; the
  prompt names only the test, so locating it is real work.

### Candidates rejected during construction (kept for the record)

- `7d42ed2 fix(isByteLength)` — its test diff adds **three** new `it()` blocks,
  more than one of which fails pre-fix. Multiple failures → violates
  "exactly one test fails."
- `3d2f4b3 fix(isISO8601)` — a clean, attractive regex bug (accepts week-zero
  `W00`), but the new invalid cases land in a **shared** `invalid` array consumed
  by two `it()` blocks (normal + `strict=true` regression), so **two** tests
  fail. Same single root cause, but still fails the one-test rule. Would be the
  next pick if a single-`it` variant is wanted.

---

## 3. Task spec

Drafted at **`bench/tasks/fix-isvat-es.json`**, filled in except `model`:

- `model` is `null` on purpose — Louis pins the exact id (or passes `--model`).
  `run.js` refuses to start while it is null, which is the intended guard.
- `repo` / `commit` point at the fixture above.
- `prompt` names the failing test, **not** `src/lib/isVAT.js`, and forbids test
  edits.
- `verify` is the RUNBOOK's three-clause check adapted to this repo's runner:
  `npm test && git diff --exit-code -- '**/*.test.*' '**/*.spec.*' && ! git diff | grep -qE '\.(skip|only)\('`
  (suite passes; no test file touched; no `.skip(`/`.only(` introduced).
- `maxTurns` (40) and `timeoutSec` (900) are **placeholders, not calibrated.**
  RUNBOOK step 2 says derive them from one manual `claude -p` run (~2× observed
  turns / duration). Do that before the real pass. The suite runs in <1s, so
  `verifyTimeoutSec` (300) is generous.

---

## 4. Remaining before a number

1. Pin `model` in the task file (or pass `--model`).
2. Calibrate `maxTurns` / `timeoutSec` from one manual run (RUNBOOK step 2).
3. Shake-out pass: `node bench/run.js --task bench/tasks/fix-isvat-es.json --model <id> --trials 3`
   and clear the four calibration checks (RUNBOOK step 3) before the real pass.

Per the task instruction, `bench/run.js` was not run and no matrix quota was
spent. This covers **prune** and **dedupe** only, not memory (RUNBOOK scope note).

Note: §§1–4 above are the **superseded** validator.js plan, kept for the record.
The current fixture work is prettier (§0 and §5).

---

## 5. Prettier fixture — construction + calibration (2026-09-04)

**Task spec:** `bench/tasks/fix-arrow-comments-prettier.json` (committed
**provisional** — see below). Repo: prettier clone at
`~/bench-candidates/prettier`, branch `bench-fixture`, SHA `6f8493d5`.

### Construction (RUNBOOK step 1)

- Fix reverted: `5a0fdd974` — *Fix unstable trailing comment on a parenthesized
  arrow chain*. One source file, `src/language-js/comments/handle-comments.js`
  (**1,344 lines**). Reverting only that file against HEAD's snapshot yields
  **exactly 2 failing tests**, both the SAME input
  `arrow-chain-with-trailing-comments.js` under `arrowParens: always` and
  `avoid` — **one root cause, two assertions**. Confirmed: restoring only
  `handle-comments.js` turns the js-family suite 28,794/0.
  - Two failures, not one, is RUNBOOK-acceptable: the one-failure rule guards
    against two *independent* bugs producing bimodal cost; here both trace to
    the single revert.
- **Reset survivability** (`git checkout -- . && git clean -fdx -e node_modules`)
  tested twice: passes. `nodeLinker: node-modules` keeps deps in `node_modules`
  (excluded from clean); only the regenerable `.yarn/install-state.gz` is
  removed, which does not break jest.
- **Verify is scoped, justified:** full `tests/format` = 2:30; the JS-family
  subset (`js`+`typescript`+`flow`+`jsx`) = **46s / 28,794 tests** and covers
  the entire blast radius of a `language-js` change while skipping the css/yaml/
  markdown/html tests it cannot touch. `verifyTimeoutSec` = 120 (~2× 46s).

### Calibration — one manual `claude -p`, sonnet-4-6, SHA 6f8493d5

| Metric | Value |
|---|---|
| num_turns | **14** |
| total_cost_usd | **$0.168** |
| duration_ms | **363,965 (~6:05)** |
| Result | success — only `handle-comments.js` changed; no test/snapshot touched; no `.skip/.only`; 28,794 js-family tests pass |

Limits set to ~2×: `maxTurns 28`, `timeoutSec 730`.

**Files read:** 2. (1) the test input `arrow-chain-with-trailing-comments.js`,
whole (small). (2) `handle-comments.js` — **offset-limited: `offset 1195,
limit 80`, i.e. 80 of 1,344 lines (~6%)**. Total tool output **12.7 KB** across
13 results; largest single result **2,354 chars / 80 lines**.

**Key question — did it bulk-read the 1,344-line file? No.** It read 6% of it,
and it navigated there via **git archaeology**: `git log` → `git show 6f8493d5`
→ `git show 5a0fdd974 -- handle-comments.js`, reading the exact original fix
diff. **Prune count = 0** — no result crossed the 120-line Bash or 400-line Read
threshold (max 80 lines).

**This run is confounded — a construction bug I introduced.** The fixture commit
message reads *"revert handle-comments.js fix from 5a0fdd974 …"*, so `git log`
handed the agent the answer's SHA. It solved the task by reading the upstream
fix, not by modelling the source, and the precise `offset 1195` read almost
certainly came from the fix diff's line numbers. So this run does **not** cleanly
answer whether prettier's source forces a bulk read.

**Two lessons:**

1. **Fixture-construction rule:** never name (or otherwise leak) the fix in the
   fixture commit message — the repo's own history is in the agent's context.
   This is the git-history analogue of "don't name the buggy file in the prompt."
2. Even so, the pattern from validator.js repeats: **two fixtures, both prune
   count 0.** A competent agent self-limits — by grep+offset read on validator.js,
   by git+offset read on prettier — so bulky content never enters the window.

*(This run's prune-0 conclusion is superseded by §6 — the leak was removed and
the task re-run, which changed the result.)*

---

## 6. Leak-free re-calibration: the first non-zero prune surface (2026-09-04)

The §5 run was confounded, so the fixture was rebuilt genuinely leak-free and
run twice — once with ctxkeep's hooks **off**, once **on**. This is the first
time any calibration has run *with the tool active*.

### Rebuilding the fixture leak-free (SHA `9944126d`)

Basing on post-fix `HEAD` leaked the answer three ways, each closed:
1. **Git history** — the fix `5a0fdd974` is a genuine ancestor, so `git log`
   shows *"Fix unstable trailing comment on a parenthesized arrow chain"*
   regardless of my commit message. → Rebuilt as a **fresh `git init`** repo:
   one neutral commit, no ancestry, no origin, no fix object in the odb
   (`git show 5a0fdd974` fails; 0 dangling commits).
2. **Changelog** — `changelog_unreleased/javascript/19930.md` (in the HEAD tree)
   *fully explains the bug and fix*; a grep of the changelog hands over the
   answer. Its sibling `19893.md` describes the same bug class. → Both removed.
3. My own commit message (from §5). → Neutral: *"bench fixture: failing arrow
   comment tests"*.

Verified: `git log` shows one neutral commit; no tree grep hit for the fix; 2
failures still reproduce; reset survives.

**Construction lesson (generalised):** a HEAD-based "revert one file" fixture is
inherently leaky — the fix's commit, changelog, and sometimes release notes all
survive in the tree/history. A leak-free fixture must be built so the fix is
*absent*, not merely renamed.

### RUN A — hooks OFF, leak-free

| Metric | Leaked run (§5) | RUN A (leak-free) |
|---|---|---|
| num_turns | 14 | **53** |
| total_cost_usd | $0.168 | **$3.30** ‡ |
| total tool output | 12.7 KB | **153.6 KB** |
| largest single result | 80 lines | **3,240 lines** (a bare Read of the .snap) |
| results ≥120 lines | 0 | 5 |
| results >400 lines (Read thresh) | 0 | 1 |

‡ wall was ~4.7 h — the run stalled repeatedly on **subscription rate limits**
(RUNBOOK step 0 warns to use an API key; I had none). Cost/wall are confounded;
treat turn count and payload sizes as the reliable signals.

Removing the leak turned a 14-turn git-lookup into a **genuine 53-turn
exploration** of an unfamiliar codebase — exactly the regime where bulky output
might accumulate. And it did, partly: 153 KB of tool output, one 3,240-line
Read. But note the shape: `handle-comments.js` (1,344 lines) was **still read in
5 offset-limited chunks** (≤150 lines each) — the agent self-limits *the file it
is pointed at*. The prune surface came instead from (i) whole-file reads of
**unfamiliar helper files** it discovered (`attach.js` 394, `print.js` 328/282,
all just under the 400-line threshold) and (ii) one accidental huge artifact
(the 3,240-line snapshot). Prune count at current thresholds: **1**.

### RUN B — hooks ON, leak-free (same prompt, same fixture)

Preflight: hooks installed at **user** level; confirmed firing under `-p`
(SessionStart wrote `.ctxkeep/state` during a headless run) and the prune path
confirmed on a synthetic 1,000-line Read (shortened to head100+tail40, pointer
written, metric recorded).

| Metric | Value |
|---|---|
| num_turns | 53 |
| total_cost_usd | $1.90 |
| duration | ~22 min (no rate-limit stall this time) |
| Result | **success** — only `handle-comments.js` changed, no test/snapshot, 28,794 js-family tests pass |
| **ctxkeep ledger** | **pruned 2 results, ~8.1k heuristic tokens** (Read `handle-comments.js` ~7,544; Bash ~602); **dedupe 0; compaction 0** |

In RUN B the agent **bulk-read `handle-comments.js` whole**, and ctxkeep pruned
it (~7.5k tokens) — run-to-run variance: sometimes the agent chunks the big file
(RUN A), sometimes it bulk-reads it (RUN B). When it bulk-reads, ctxkeep bites.

**Do not read the $3.30→$1.90 drop as savings.** Same 53 turns; the difference
is dominated by RUN A's rate-limit/caching confound and a different exploration
path, at n=1 each. The only defensible ctxkeep signal is the ledger: **~8.1k
heuristic tokens on a session whose footprint was ~88.7k cache-creation /
~2.35M cache-read input tokens** — a modest slice, and 2 prunes out of ~52 tool
results. The task still succeeded, so ctxkeep did not break it.

### Verdict (the honest read; see the session report for the argued version)

- **(a) Fixtures still slightly wrong?** Partly, but the *class* is the problem,
  not the instance. A single-bug fix task gives one genuinely-hard region; even
  then a competent agent self-limits the file it is handed. The task shape that
  would reliably trigger pruning is a **long multi-file refactor / wide
  exploration across many unfamiliar files** (or a **multi-session** task that
  actually compacts, exercising memory) — not single-bug fixes.
- **(b) Thresholds too high — this is the strongest concrete finding.** The
  agent's whole-file reads cluster at **~150–400 lines** (`attach.js` 394,
  `print.js` 328/282, `handle-comments` chunks ≤150). The **400-line Read
  threshold sits at the top of that distribution and barely catches anything**;
  only a freak 3,240-line snapshot tripped it in RUN A. A Read threshold nearer
  **~150–200 lines** would have pruned the real accumulation (4–6 results
  instead of 1–2). Fidelity cost: more head/tail elisions the agent might have
  to expand — measure the re-fetch rate before lowering.
- **(c) Modern agents self-limit; prune value on this class is near zero, and
  the tool's value likely lies elsewhere.** Four calibrations: three at prune 0,
  one at 2. The agent greps, offset-reads, and chunks big files on its own.
  ctxkeep's payoff is concentrated in the tail (the occasional bulk read / giant
  artifact) and, untested here, in **dedupe on re-read-heavy tasks** and
  **memory across compaction** — neither of which a single-bug, single-session
  fixture exercises (dedupe 0, compaction 0 in both runs).

**Bottom line:** on single-bug fixture tasks the pruning mechanism earns little
because agents already avoid loading bulk. Before investing more in prune
tuning, either (b) lower the Read threshold and measure the fidelity cost, or
pivot the benchmark to the shapes where the tool could actually pay —
wide/long exploratory sessions and multi-session memory. `bench/run.js` was not
run; no matrix quota spent.

---

## 7. Exploratory benchmark design (2026-09-05) — DESIGN ONLY, nothing run

Every fixture so far is a single-bug fix: one hard region, the agent self-limits,
prune ≈ 0, dedupe 0, memory 0 (§6). Q1 (§11) established the cost driver is
**prefix size × turns**, so the mechanism that could matter is prefix growth over
a *long* session — not any single result. This section designs the fixture shape
the project has never tested. It is a design; no repo was constructed and
`bench/run.js` was not run.

### 7.1 The four requirements, and the tension between them

- **Long (40+ turns):** enough that prefix growth dominates and compaction
  *plausibly* triggers — the only way memory is exercised at all.
- **Wide (many unfamiliar files):** the agent must *read to build a model*, not
  grep to a known symbol — the only condition under which the 200-line Read prune
  fires on more than a freak artifact.
- **Re-read heavy (same files revisited):** the only condition under which dedupe
  does anything.
- **Verifiable (programmatic pass/fail):** or the run is unscoreable. This is the
  hard one — exploratory tasks resist strict verification.

Two design tensions must be stated up front because they shape every candidate:

1. **Verifiability vs. exploration.** The more open-ended the task, the weaker the
   verifier. A feature with a brought-forward acceptance suite is strictly
   scoreable but partly bounded (the tests define "done"); documentation quality
   is genuinely exploratory but has *no* programmatic verifier. You cannot have
   maximum of both.
2. **Pruning delays the compaction memory needs.** With Read→200 active, the
   prefix grows *slower*, so a task tuned to compact in the `off` arm may **not**
   compact in the `prune`/`full` arms. Memory then fires in one arm and not
   another — confounding the comparison. Measuring memory honestly needs a design
   where compaction is forced (a hard context cap) or a multi-session A/B, not a
   single long run.

### 7.2 Three candidate tasks

Repos anchored where possible to ones already cloned + installable (§0.2). All
would be constructed SWE-bench-style (check out before the change, bring the
change's *tests* forward) and **leak-free** per the §6 rule (fresh `git init`,
strip changelog/history that names the change).

**Candidate D — implement a feature spanning modules (eslint).**
- *Repo:* `eslint` (cloned, `node Makefile.js test`, mocha). *Shape:* check out
  the parent of a real `feat:` commit that touched core + multiple `lib/rules/*`
  (e.g. a new language/scope capability threaded through several rules), bring its
  test files forward, prompt names the failing behaviour, **not** the files. To
  make the tests pass the agent must read existing rules + shared
  `lib/rules/utils/ast-utils.js` and the scope analyser to learn the (un-greppable)
  rule/AST API.
- *Verifier (strict):* `node Makefile.js test` green **and** the brought-forward
  test files pass **and** `git diff --exit-code` on all `tests/**` **and** no
  `.only(`/`.skip(` introduced. Programmatic, strong.

**Candidate E — raise coverage of a complex untested module.**
- *Repo:* a branch-heavy parser/state-machine module in a c8-instrumentable repo
  — concretely `marked` (lexer/Tokenizer/Parser) or `eemeli/yaml` (parse →
  compose → stringify). Would need cloning + a screening pass like §0.2. *Shape:*
  pick a module whose current branch coverage is low; prompt: raise it to ≥ T%
  without editing source. The agent re-reads the *same* target module across many
  turns as it chases uncovered branches — the strongest dedupe surface of the
  three.
- *Verifier (weak→partial):* `c8`/jest coverage on the target file ≥ T% branch
  **and** suite green is programmatic but **gameable** — coverage counts lines
  executed, not asserted; an agent can hit branches with assertion-free tests.
  The *strict* verifier is a **mutation score** (Stryker) on the target module ≥
  M%, which is real but slow/expensive (minutes–tens of minutes per run, ×24).
  Honest partial if Stryker is too costly: coverage ≥ T% **and** a lint that every
  new `test(...)` contains ≥1 assertion — catches the crudest gaming, not all.

**Candidate F — migrate a deprecated API across the codebase (cautionary).**
- *Repo:* any with a real migration commit touching many call sites (e.g. an
  internal helper rename, `assert.equal`→`assert.strictEqual`, a deprecated option
  swept out). *Shape:* check out before it; prompt: replace every use of X with Y,
  suite must pass.
- *Verifier (strict, trivial):* `grep -rc '<oldAPI>' src == 0` **and** suite
  green. The easiest verifier of the three — and that is exactly the problem: the
  task is **mechanical**. The agent greps to the call sites and edits them; it
  self-limits (the §6 trap at scale), visits each file roughly once. Included as a
  **negative control**, not a real bet.

### 7.3 Which mechanism each would actually exercise (honest)

| Candidate | Prune (Read→200) | Dedupe | Memory (compaction) | Verifier |
|---|---|---|---|---|
| **D** feature/eslint | **High** — must read many unfamiliar rule/util files whole | Med — shared `ast-utils`/scope revisited | Low–Med — long enough to *maybe* compact | **Strong** |
| **E** coverage | Med — reads the complex module + deps | **Highest available** — re-reads the target across turns | Med — long | **Weak** (gameable; strict = costly mutation) |
| **F** migration | **Low** — mechanical grep-and-edit | Low — each file visited once | Low | Strong but the task is trivial to self-limit |

### 7.4 Matrix cost (honest estimate)

Anchored to observed runs (RUN B: 53 turns, ~$1.90; exploratory tasks run longer
and read more, and the `full` arm's dedupe denials cost extra turns). With an API
key (no subscription rate-limit stall):

- **Per run:** ~$2–4 (40–70 turns), plus verify time. eslint's full suite is
  minutes, so each of the 24 verifies adds real wall time; mutation-scored E is
  far worse (tens of minutes/verify).
- **Shake-out** (3 arms × 3 trials = 9 runs): **~$20–40**, ~2–4 h wall.
- **Full matrix** (3 arms × 8 trials = 24 runs): **~$50–100**, ~half a day wall.
- **Per task total ~$70–140.** RUNBOOK step 5 wants 3–4 shapes before
  generalising → **~$250–500** for a defensible multi-task claim. The dominant
  uncertainty is turn count: any task that balloons to `maxTurns` inflates this.

### 7.5 Recommendation — and whether to run at all

**Run Candidate D, shake-out only, first.** It is the one task that (a) has a
strict verifier and (b) genuinely exercises the mechanism Q1 says matters (prune
on unfamiliar wide reads at the new 200 threshold). Do the 9-run shake-out
(~$20–40), read the ledger for **prune count, re-fetch rate, and net prune**, and
only escalate to the full 24-run matrix if the shake-out shows a prune signal
*and* success rates hold across arms. Do **not** commit to the full 3–4-shape
matrix up front.

**Do not run E or F expecting them to settle dedupe or memory.** E is the only
dedupe-oriented shape and its verifier is the weakest; F is a negative control.
If the specific goal is validating dedupe or memory, the honest answer is **this
fixture class is not worth running for that** — see §7.6.

### 7.6 Do I expect the result to differ from the four calibrations? (blunt)

Asked directly, before money is spent:

- **Prune: yes, this will move clearly off zero — this is the one number worth
  buying.** The payload sweep (§11 / STEP 1) already shows ~12% of *all* Reads
  cross the new 200-line threshold, and RUN A (leak-free, hard) showed the agent
  reading unfamiliar helper files whole at 150–394 lines — sizes that pruned at 0
  under the old 400 rule and prune now. A wide task multiplies exactly those
  reads. Expect a real prune count and, more importantly, the **first honest
  net-prune-minus-re-fetch number on a long session** — which is the whole point.
- **Dedupe: no, I expect it to stay near zero even on E.** Dedupe requires a
  **byte-identical re-read**, and agents don't revisit files that way — they grep,
  offset-read the relevant span, or work from memory. The four calibrations hit
  dedupe 0 not because the tasks lacked re-reads but because the re-reads weren't
  identical. A better fixture cannot fix a **mechanism–behaviour mismatch**; if
  dedupe is to matter it needs redesigning around *file identity* (path + mtime/
  hash, any offset) rather than exact-text equality. Say so before paying to
  re-confirm zero.
- **Memory: at best one compaction snapshot; effectively unmeasured.** A 40+ turn
  wide task on a big repo *might* compact and fire the snapshot/restore — but (i)
  active pruning delays that compaction (§7.1), and (ii) a single-session run can
  only show memory *fired*, never that restored context *helped*. Scoring
  memory's value needs a multi-session A/B, which this shape is not.

**Bottom line:** worth spending the shake-out (~$20–40) on **Candidate D** for the
first real prune/re-fetch number on a long session — that number is genuinely
unknown and decision-relevant. It is **not** worth spending on dedupe or memory
validation: dedupe needs a mechanism change, memory needs a different experiment.
If the goal is specifically "prove dedupe/memory work," the honest recommendation
is **do not run** — fix the dedupe mechanism and design a multi-session memory
test instead.
