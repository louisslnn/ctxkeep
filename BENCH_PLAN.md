# BENCH_PLAN.md — preparation for TASKS.md 2.4 (benchmark)

Status: **BLOCKED on missing bench spec.** Preparation that does not require
inventing that spec is below. No quota was spent; `bench/run.js` was not run
(it does not exist).

---

## 1. The blocker

Task 2.4 step 1 is "Read `bench/RUNBOOK.md` end to end." It is not there. The
entire `bench/` tree is:

```
bench/
  tasks/        (empty)
```

Missing, and required before the rest of 2.4 can be done honestly:

| Missing file | 2.4 step it gates |
|---|---|
| `bench/RUNBOOK.md` | step 1 (read it); step 2 ("its step 1 criteria" for candidate repos) |
| `bench/run.js` | the harness I'm told **not** to run — but also the thing that defines a run |
| an example `bench/tasks/*.json` | step 4 (draft a task file "filled in except the model") |

Without the RUNBOOK I do not have the repo-selection criteria. Without `run.js`
or an example task file I do not have the task-JSON schema. Drafting either from
imagination would be fabricating the spec — the exact failure this recovery run
was opened to correct (the earlier self-authored `ARCHITECTURE.md`). So I am not
inventing a RUNBOOK, a `run.js`, or a task-file schema. The rest of this file is
the preparation that stands on its own.

---

## 2. Inferred criteria (provisional — reconcile against the real RUNBOOK)

These are read off `ARCHITECTURE.md` §5/§9 and `TASKS.md` 2.4/3.4, **not** off
the missing RUNBOOK. Treat them as my working assumptions, to be replaced by the
RUNBOOK's actual step-1 criteria when it lands.

1. **Single-session task.** The bench isolates prune + dedupe. A single-session
   task rarely triggers compaction (TASKS.md 3.4 says memory is *not* covered
   until a compaction-spanning task exists), so memory is out of scope here.
2. **Large tool-output surface.** Pruning targets the biggest thing in the
   window (ARCHITECTURE §5). A good fixture makes the agent read large files,
   grep broadly, and run a verbose test suite — otherwise there is nothing to
   prune and the arms converge.
3. **Dedupe surface.** Many files the agent will re-read across the task (so the
   PreToolUse dedupe arm has something to deny).
4. **Deterministic, objective success.** A specific test that fails before and
   passes after the fix — hence 2.4's "verify the test actually fails." Success
   must be machine-checkable, not judged.
5. **JS/TS.** The eval fixtures are JS/TS-tuned and "fidelity numbers don't
   transfer across languages" (ARCHITECTURE §9.3, CONTEXT.md). Cross-language
   pruning was only just validated in 2.3; the first honest bench number should
   be on the stack the pruner is actually tuned for.
6. **Self-contained, permissive, pinned.** MIT/BSD/Apache, installs cleanly, and
   pinned to a fixture SHA (2.4 requires reporting the fixture SHA).
7. **Cheap enough to run the matrix.** Small enough that N repetitions × arms ×
   model stays within a sane quota; large enough to satisfy (2).

---

## 3. Three candidate fixture repos

Each is proposed against §2, with the tradeoff named. Final selection and exact
SHAs must be re-checked against the real RUNBOOK criteria; SHAs are intentionally
not pinned here because the selection rule is what's missing.

### Candidate A — `colinhacks/zod` (TypeScript, MIT) — **top pick**
- **For:** large TS source and a very large test suite → verbose test runs
  (bulky `Bash` output) and big file reads (bulky `Read`). Best pruning surface
  of the three. Deterministic vitest pass/fail. Widely used, so a seeded-bug
  task is realistic.
- **Against:** the test suite is big, so each arm's wall-clock and token cost is
  the highest here — the (2) vs (7) tension. Mitigate by scoping the task to one
  test file the agent must get green, not the whole suite.

### Candidate B — `date-fns/date-fns` (JS/TS, MIT)
- **For:** hundreds of small single-purpose modules → strong **dedupe** surface
  (the agent re-reads neighbours while fixing one function) and many `Grep`/
  `Glob` hits. Deterministic jest tests. Easy to seed a one-function bug with a
  single failing test.
- **Against:** individual files are small, so `Read` pruning bites less than in
  zod. Better for exercising dedupe than prune.

### Candidate C — `sindresorhus/p-limit` (or a similar small MIT utility)
- **For:** tiny, fast, near-zero setup, fully deterministic — a cheap **control**
  fixture to validate the harness end-to-end before spending on A/B.
- **Against:** almost no pruning surface (little output to shorten). Useful as a
  smoke test / lower bound, not as the headline number.

**Recommended:** construct on **A (zod)** for the headline number, keep **C** as
the harness smoke test, hold **B** as the dedicated dedupe fixture.

---

## 4. Top candidate — construction status

The task asks me to construct the top-candidate fixture "through to *verify the
test actually fails*" and to draft `bench/tasks/<name>.json`. Both are blocked,
and here is exactly where:

- **Verify-it-fails** is doable *independently* of the RUNBOOK — clone zod at a
  pinned SHA, revert a known one-line validation fix (or seed a bug), run its
  own test runner, and confirm the target test fails. That step does **not**
  need `run.js`. But doing it before the RUNBOOK exists risks building a fixture
  whose shape (size, success-metric format, arms) doesn't match what the harness
  will require — wasted work on a guessed schema. I've therefore not cloned or
  built anything yet; I can execute this the moment you confirm you want it, or
  once the RUNBOOK lands. It needs a network clone + `npm install` in that repo
  (not this one — no new deps enter `src/`/`hooks/`).
- **Draft `bench/tasks/<name>.json`** is **not** doable without the schema. There
  is no `run.js` and no example task file to read the shape from. A JSON I made
  up would be a fabricated spec. Deferred until the schema exists.

What a task file will need to carry, regardless of exact schema (from 2.4's
own wording — median, CI, success rate per arm, model, fixture SHA): the repo +
pinned SHA, the setup/install command, the agent prompt, the objective success
check (the command whose exit code decides pass/fail), the arms to compare
(baseline / prune / dedupe / both), repetition count, and a `model` field —
which per your instruction I would leave for you to fill.

---

## 5. What I need to unblock 2.4

1. `bench/RUNBOOK.md` (the step-1 repo-selection criteria and the run protocol).
2. `bench/run.js`, or any one example `bench/tasks/*.json`, to fix the task
   schema.
3. A yes/no on whether to go ahead and clone + seed + verify-it-fails on zod
   **now**, blind to the RUNBOOK, or wait for it.

Until then: 2.4 is not started beyond this plan, by design. `bench/run.js` was
not run; no quota was spent.
