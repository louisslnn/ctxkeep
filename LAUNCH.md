# Launching Claude Code on the backlog

## Before you start

**1. Get the spec files into the repo.** The backlog references files that
aren't there yet:

```bash
cd ~/ctxkeep
cp /path/to/CLAUDE.md /path/to/TASKS.md /path/to/ARCHITECTURE.md .
cp -r /path/to/bench .
git add -A && git commit -m "docs: add architecture, backlog, and benchmark harness"
```

**2. Disable ctxkeep's own hooks for this work.**

If ctxkeep is installed at user level, it will prune tool output *while Claude
Code is debugging the pruner*. You will spend hours chasing behaviour caused by
your own tool. Comment the hooks out of `~/.claude/settings.json` for the
duration, and confirm:

```bash
claude -p "Read package.json and reply with the version field" --output-format json | jq -r '.result'
# then check no new files appeared:
ls .ctxkeep/cache 2>/dev/null | wc -l   # must be 0
```

**3. Work on a branch, in a worktree.**

```bash
git worktree add ../hc-phase0 -b phase-0
cd ../hc-phase0
```

**4. Decide about permissions.** For an unattended run you'll want
`--permission-mode acceptEdits` so it isn't blocked on every file write. Avoid
`--dangerously-skip-permissions` outside a container — it lets the agent run
arbitrary shell commands unattended in a repo where you've also told it to
delete files and rewrite history.

---

## Prompt A — Phase 0 (repo hygiene, ~1 hour, expect blockers)

Not fully autonomous. Several tasks need a decision or a credential you have
to supply. The prompt is written so it stops rather than guessing.

```
Read CLAUDE.md, ARCHITECTURE.md, and TASKS.md. Work Phase 0 only. Stop at the
Phase 0 gate.

Working loop, one task at a time, in order:
1. Read the task. Restate in one line what you're about to change.
2. Make the change.
3. Run the task's "Done when" check plus `npm test` and `npm run eval`.
4. Commit with a conventional message referencing the task number.
5. Move to the next task.

Do not batch tasks into one commit. Do not skip ahead.

Three tasks need input from me. Do NOT guess or proceed on these — do the
research, write your findings and a recommendation into BLOCKED.md, and
continue to the next task:

- 0.1 (naming): check npm availability for the candidate names and report
  which are free. I choose the name, not you.
- 0.3 (removing kickbacks artifacts): delete them from the working tree and
  commit that. Do NOT rewrite history or force-push. Write the exact commands
  you'd run for the history rewrite into BLOCKED.md instead.
- 0.5 (install paths): do not run `npm publish` or create a marketplace repo.
  Report what each would require.

When you reach the gate, run it, then write a summary of what changed, what's
in BLOCKED.md, and anything in TASKS.md you found to be wrong or already done.
```

---

## Prompt B — Phase 1 (the real long run)

This is the one that can go for hours unattended. Every task has a regression
test as its acceptance criterion, which is what makes an unsupervised run
safe to leave alone.

Run it after Phase 0's gate passes and you've settled the naming decision.

```
Read CLAUDE.md, ARCHITECTURE.md, and TASKS.md. Work Phase 1 only: tasks 1.1
through 1.6, in order. Stop at the Phase 1 gate.

Each of these is a confirmed defect. For every one:
1. First write a test that FAILS against current code and demonstrates the
   defect. Run it. Confirm it fails for the stated reason, not an unrelated one.
2. Then fix the code.
3. Confirm the test now passes, and that `npm test` and `npm run eval` both
   pass.
4. Commit test and fix together, referencing the task number.

If a test passes before you've written any fix, the defect is not what
TASKS.md describes. Stop, write what you actually found into BLOCKED.md, and
move to the next task. Do not adjust the test until it fails.

Task 1.4 needs real captured payloads from live Claude Code sessions. If you
cannot capture them from inside this session, write down the exact capture
procedure in BLOCKED.md and skip the task rather than inventing fixtures.

Constraints:
- Never weaken, skip, or delete an existing test to make something pass.
- No new runtime dependencies in src/ or hooks/.
- The eval harness exiting non-zero is a hard failure, not a warning.
- Respect every invariant in CLAUDE.md. If a fix seems to require breaking
  one, stop and write up the conflict instead.

When you reach the gate: run it, then write a summary of each defect — what
the root cause actually was, how you fixed it, and how the test proves it.
```

---

## While it runs

Check in on these rather than reading every diff:

- **`git log --oneline`** — one commit per task, in order. Several tasks in one
  commit means it stopped following the loop.
- **`BLOCKED.md`** — the honest signal. An empty BLOCKED.md after Phase 0 means
  it guessed at something it shouldn't have.
- **`git diff main -- test/`** — check tests were *added*, not modified.
  Weakened assertions are the most common way a long run fakes a green gate.
- **`npm run eval`** yourself at the end. Don't take the summary's word for it.

## After

Phase 2 is mostly CI and docs and runs fine unattended with the same loop.

**Phase 3 is different — supervise it.** Structure-aware pruning is a design
problem, not a defect list, and an agent left alone on it produces a lot of
plausible code that doesn't survive a real session. Do 2.4 first: without a
benchmark number, you have no way to tell whether a Phase 3 change helped.
