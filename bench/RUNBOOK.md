# Runbook — producing your first number

Every command, in order, with the decision points spelled out. Budget about
half a day: two hours of setup, then a few hours of unattended runs.

**Scope note before you start.** This measures the **prune** and **dedupe**
mechanisms. It does *not* measure memory — a single-session task rarely triggers
compaction, so `CONTEXT.md` never comes into play. Measuring memory needs a
multi-session design and a different task shape. Don't quote a number from this
harness as evidence that the memory feature works.

---

## Step 0 — Environment hygiene

These four things confound the result if you skip them.

```bash
# 1. Pin the model. The runner now refuses to start without --model.
#    If routing shifts between the `off` runs and the `prune` runs, you have
#    measured a model change.

# 2. Use an API key, not the subscription. You want per-run cost precision
#    and no weekly rate limit stalling the matrix halfway through.
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Install ctxkeep's hooks at USER level, not project level.
#    Project hooks are subject to workspace trust and may not register
#    under `-p`. This is the most common reason a benchmark produces zeros.
ctxkeep init          # then move the hooks block into ~/.claude/settings.json

# 4. Disable other plugins and hooks for the duration. Anything else touching
#    tool results is noise you can't separate from signal.
```

---

## Step 1 — Build the fixture repo

### Choosing a repo

It needs all four of:

- A real test suite with a **fast, deterministic** run (under ~60s, no network, no flakes)
- Enough size that finding a bug requires exploring several files — under ~5k LOC and there's nothing to prune
- A dependency install that works offline after the first `npm ci`
- A history containing real bug-fix commits (see below)

Run the suite three times before committing to it. If the pass set differs
between runs, the repo is flaky and every number you produce will be noise.

### Constructing the task state

Don't hand-write a bug. Take a real one from history — the state right before a
fix, with the fix's test brought forward. This is how SWE-bench-style fixtures
are built, and it gives you a task with a genuine root cause in the source.

```bash
git clone <repo> ~/bench-fixture
cd ~/bench-fixture
npm ci                      # `ci`, not `install` — deterministic tree

# Find a bug fix that also touched tests
git log --oneline -50 --grep='fix' -- src/

FIX=<sha-of-a-fix-commit>

# Confirm it changed both source and a test
git show --stat $FIX

# Check out the state BEFORE the fix, then bring the fix's test forward.
# Result: source is buggy, test proves it.
git checkout -b bench-fixture $FIX^
git checkout $FIX -- <path/to/the/test/file>

# Verify the test actually fails, and that ONLY it fails
npm test 2>&1 | tail -30

git commit -am "bench fixture: failing test from $FIX with pre-fix source"
git rev-parse HEAD          # ← this is your `commit` value
```

**Validate before going further.** The fixture is only good if:

- Exactly one test fails, and it fails for the intended reason
- The fix is in *source*, not in the test
- Reverting to `$FIX` makes it pass — confirm with
  `git stash && git checkout $FIX -- src/ && npm test`

If more than one test fails, narrow it or pick a different commit. A task with
two independent bugs produces bimodal cost distributions that no amount of
trials will clean up.

---

## Step 2 — Write the task spec

```bash
cd /path/to/ctxkeep
cp bench/tasks/example.json bench/tasks/mytask.json
```

Four fields need real thought.

### `prompt`

**Do not name the buggy file.** The exploration is the thing being measured — if
you point the agent straight at the file, both arms read one file and you learn
nothing.

Name the failing test, forbid touching tests, require verification:

```
"The test suite has one failing test: <exact test name>. Find the root cause
in the source and fix it. Do not modify any test file. Run the full suite to
confirm it passes before you finish."
```

### `verify`

Must be strict enough that a plausible-but-wrong answer fails. Three clauses:

```json
"verify": "npm test -- --run && git diff --exit-code -- '**/*.test.*' '**/*.spec.*' && ! git diff | grep -qE '\\.(skip|only)\\('"
```

1. The suite passes
2. No test file was modified
3. No `.skip(` / `.only(` was introduced anywhere

Without clause 3 an agent can make the suite green by skipping the test, and
your harness will score it a pass.

### `maxTurns` and `timeoutSec`

**Calibrate these with one manual run.** Don't guess.

```bash
cd ~/bench-fixture && git checkout bench-fixture && git clean -fdx -e node_modules
time claude -p "<your prompt>" --output-format json --model <id> \
  --max-turns 60 --dangerously-skip-permissions | jq '{num_turns, total_cost_usd, duration_ms}'
```

Set `maxTurns` to roughly **2× the observed turn count** and `timeoutSec` to
**2× the observed duration**. Too tight and the baseline hits the ceiling and
fails; every arm then gets compared against garbage.

### `model`

Put the exact model id in the spec so the run is reproducible from the file
alone.

---

## Step 3 — Shake-out pass

```bash
node bench/run.js --task bench/tasks/mytask.json --model <id> --trials 3
```

Preflight runs first: a trivial prompt, then a check that ctxkeep's ledger
recorded something. If it aborts here, the hooks are not firing headless — fix
that before anything else.

Nine runs, ~20 minutes. **You are not looking at savings yet.** Four
calibration checks:

| Check | Threshold | If it fails |
|---|---|---|
| `off` arm success rate | ≥ 2/3 | Task is too hard or ambiguous. Tighten the prompt. |
| `off` arm median cost | ≥ ~$0.15 | Task is too small. Nothing to prune; pick a bigger one. |
| ctxkeep ledger prunes | > 0 on prune/full arms | Hooks not firing, or nothing exceeded the thresholds. |
| Cost spread (p25–p75) | narrower than ~2× the median | Extremely noisy; you'll need far more than 8 trials. |

Fix whatever fails and re-run the shake-out. Do not proceed on a task that
fails any of these — 24 runs against a bad fixture is 24 runs wasted.

---

## Step 4 — The real pass

```bash
node bench/run.js --task bench/tasks/mytask.json --model <id> --trials 8 \
  2>&1 | tee bench/results/run.log
```

24 runs. Estimate the wall time and cost from the shake-out and multiply by 8.
It runs unattended; results append to the JSONL after each trial, so a crash
mid-matrix doesn't lose what completed.

```bash
node bench/report.js bench/results/<run-id>.jsonl
```

### Reading it

**Look at the CI before the headline.** If the 95% interval includes zero, you
do not have a weak result — you have no result. Options in order of preference:
a task with more headroom, then more trials, then accept that the effect is too
small to detect at this sample size and say so.

**Look at the success-rate warning before the savings.** If `prune` cost 25%
less but passed 5/8 where `off` passed 8/8, ctxkeep is breaking the task and
the cost figure is meaningless. Investigate before tuning: read the failing
runs' transcripts in `~/.claude/projects/` and check whether the model needed
something that got pruned away.

**Compare the arms against each other, not just against baseline.** If `full`
is no better than `prune`, dedupe is earning nothing and the deny-costs-a-turn
tradeoff is net-neutral. That's a real finding and it should change the default
config.

**Treat the self-report line as a bug report.** When ctxkeep's ledger claims
much more than billing moved, the difference is usually the model spending
extra turns re-fetching what got pruned. That gap is a tuning signal.

---

## Step 5 — Before you publish a number

Say all of this alongside it, or the number is misleading:

- Which model, pinned
- Which repo and task, with the fixture commit SHA
- How many trials per arm
- Median with the confidence interval, never the median alone
- Success rate per arm
- That it covers prune and dedupe, not memory
- That it is one task — "on this task" not "on coding work"

Then run three or four more tasks of different shapes before you generalize to
a claim about a class of work.
