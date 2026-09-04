# BENCH_PLAN.md — preparation for TASKS.md 2.4 (benchmark)

Status: **Fixture constructed and validated. Ready for the shake-out pass.**
`bench/RUNBOOK.md`, `bench/run.js`, `bench/report.js` and `bench/tasks/example.json`
are now in place, so the earlier blocker is resolved. `bench/run.js` was **not**
run — no matrix quota was spent. What remains before a real pass is model
selection (Louis) and the RUNBOOK step-2 turn/timeout calibration.

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
