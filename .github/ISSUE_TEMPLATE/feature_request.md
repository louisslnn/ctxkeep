---
name: Feature request
about: Propose a change to how ctxkeep prunes, dedupes, or persists memory
title: ""
labels: enhancement
assignees: ""
---

## The problem

<!-- What context/token problem are you hitting? A concrete session where
     ctxkeep left tokens on the table, or pruned something it shouldn't have. -->

## Proposed change

<!-- What you'd like it to do instead. -->

## Which half does this belong in?

ctxkeep splits mechanics from judgment (see `ARCHITECTURE.md` §2):

- [ ] Hook mechanics (`hooks/`, `src/`) — pure, fast, no model calls
- [ ] Skill judgment (`skills/ctxkeep/`) — when to expand, what to remember
- [ ] Not sure

## Invariant check

Does this require rewriting turns already in context, an LLM call inside a hook,
or a prune without a retrieval pointer? If so it likely conflicts with an
invariant in `ARCHITECTURE.md` §6 — note how you'd keep those intact.
