---
name: ctxkeep
description: How to work in a repo where ctxkeep is managing the context window — recovering the full text of a tool result that was shortened to a `.ctxkeep/cache/...` pointer, responding to a denied duplicate Read, and recording durable knowledge into CONTEXT.md so it survives compaction. Use this skill whenever a tool result ends with a `[ctxkeep]` marker, whenever a Read is denied as an unchanged duplicate, whenever a CONTEXT.md exists at the project root, and whenever the session is approaching compaction or wrapping up work worth carrying forward — even if the user never mentions ctxkeep by name.
---

# ctxkeep

This repo uses ctxkeep to manage the context window. Two things are happening
automatically that change how you should work.

## 1. Tool results may be shortened

Long file reads and command output are pruned before they reach you. A pruned
result has elision markers in the middle and ends with:

```
---
[ctxkeep] This output was shortened to save context.
Full result (1847 lines) is at: .ctxkeep/cache/toolu_01ABC.txt
Read that path if the elided section matters. It is exempt from pruning.
```

**Treat pruning as reversible, not as the end of the story.** The elided middle
still exists on disk. Read the cache path when:

- You need a specific line, function, or symbol that isn't in the kept head or tail
- You are about to edit a file and only saw part of it
- The elision marker sits exactly where the thing you're looking for should be

Do **not** read the cache path reflexively after every prune. That defeats the
whole mechanism. The head, the tail, and any preserved error lines answer most
questions on their own.

**A better move than reading the whole cache file is usually a targeted search.**
`Grep` for the symbol you need against the original path. You get the same answer
for a fraction of the tokens.

Cache files are exempt from pruning, so reading one returns it in full — which
means a large one costs full price. Prefer Grep, or Read with `offset` and
`limit`, when you know roughly where to look.

## 2. Recording durable knowledge

`CONTEXT.md` at the project root survives compaction and is re-injected at the
start of every session. Anything not written down there is lost when the context
window is compacted.

Update it when you learn something that would cost real time to rediscover.
The four sections:

- **Decisions** — a settled choice *and its reason*. The reason is the valuable
  half; without it the decision gets re-litigated next session.
- **Constraints** — non-obvious rules discovered by working here. "The seed
  script assumes migrations already ran." "The staging bucket is us-east-1, not
  eu-west-1 like everything else."
- **Ruled out** — approaches tried and rejected, and why. This is the
  highest-value section. Without it, every fresh context walks into the same
  dead ends.
- **Open threads** — work in flight. Delete entries when they finish.

### What belongs, and what doesn't

Write it if it will still be true and still be useful in a month.

| Record | Don't record |
|---|---|
| "Auth uses short-lived JWTs; sessions in Redis were rejected because the edge workers can't reach Redis." | "Fixed the login bug." |
| "`npm test` needs `DATABASE_URL` set or it hangs with no output." | "Ran the tests, 3 failed." |
| "Tried Prisma for the reporting queries; the generated SQL couldn't express the window functions, so those go through raw `pg`." | "Considered a few ORMs." |
| "The `legacy/` directory is dead code pending removal in Q4." | "Read through legacy/parser.js." |

Skip anything already in `CLAUDE.md`. That file is for standing conventions and
loads on its own. `CONTEXT.md` is for what you can only learn by working in the
repo.

Skip transient state — what you're mid-way through right now, which test is
currently failing, today's branch name. It will be stale before it is read.

### How to write it

Read the file first, then edit the relevant section. Keep entries to one or two
lines. Delete entries that have stopped being true rather than accumulating
contradictions — a memory file that contradicts itself is worse than none,
because it makes the reader distrust all of it.

Add entries as you go rather than batching them at the end of a session. The end
of a session is exactly when compaction is most likely to have already happened.

## When the user asks about savings

`ctxkeep stats` prints the per-session ledger: tokens pruned, tokens re-fetched,
and which tools account for the most. `ctxkeep doctor` verifies the hooks are wired
up and reports the tool-result shape the installed Claude Code version emits.

Report the numbers as estimates. ctxkeep counts tokens with a character-ratio
heuristic, not a real tokenizer, so treat the figures as directionally right
rather than exact — and say so if the user is going to act on them.
