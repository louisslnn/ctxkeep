# Review loop

Three layers. Use them in this order — the cheap ones first.

| Layer | What | Cost | Catches |
|---|---|---|---|
| `gate.sh` | Deterministic checks | free | weakened tests, new deps, foreign artifacts, invariant tripwires, failing gates |
| `review.sh` | Independent LLM review of the diff | one model call | wrong behaviour, tests that cannot fail, silent failures |
| `hook-stop.sh` | Wires both into the turn boundary | — | the loop itself |

## Why independence matters

`review.sh` spawns a separate `claude -p` with a fresh context window. The agent
that wrote the code has already justified every decision it made; asking it to
review its own work in the same context produces agreement, not review.

A subagent has a separate context window, which is better than nothing, but it
still reports to the agent that decided what to build — and that agent decides
whether to act on it. A separate process reviewing a diff it has no history
with is the real thing.

## Why the free layer comes first

Most of what goes wrong in an unattended run is mechanically detectable: a
shrinking test file, a new dependency, an assertion count that went down. An
LLM asked to check those does it worse, slower, and inconsistently — and you
pay for it. Spend model calls on judgment only.

`gate.sh` also runs before `review.sh` in the hook, so a diff with failing
tests never costs a review call.

## Install

```bash
chmod +x review/*.sh

# .claude/settings.json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bash",
        "args": ["$CLAUDE_PROJECT_DIR/review/hook-stop.sh"],
        "timeout": 300
      }]
    }]
  }
}
```

Set `REVIEW_BASE` to review against something other than `HEAD` — e.g.
`REVIEW_BASE=main` to review the whole branch rather than uncommitted work.

## The loop guard

A Stop hook that always blocks loops forever. Claude Code sets
`stop_hook_active: true` when the hook fires because of a previous block, but
**it does not break the loop for you** — you must check it and exit 0.

`hook-stop.sh` gives exactly **one** review-and-fix round per turn. On the
second pass it re-runs only the free gate and, if still failing, appends to
`REVIEW_FAILED.md` rather than blocking again.

That bound is deliberate. A reviewer that keeps finding things forever is
usually finding nothing, and an unbounded loop is a quota incident.

## Running it manually

```bash
bash review/gate.sh                 # free, instant
bash review/review.sh main          # review the branch
```

## What to check yourself

The loop does not remove the need to look. After a long run:

```bash
git log --oneline                   # one commit per task, in order?
git diff main -- test/              # tests added, not modified?
cat REVIEW_FAILED.md 2>/dev/null    # anything escalated?
ls review/findings/                 # what did the reviewer flag, and was it addressed?
npm run eval                        # verify yourself; don't trust the summary
```

`review/findings/` accumulates every verdict. Reading a few is the fastest way
to tell whether the reviewer is doing real work or rubber-stamping — if every
verdict is `pass` with an empty findings array, the prompt needs to be harder,
or the diffs are too large for it to see anything.
