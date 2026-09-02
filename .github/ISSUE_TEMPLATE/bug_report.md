---
name: Bug report
about: Something ctxkeep did wrong — a lost result, a broken session, a bad prune
title: ""
labels: bug
assignees: ""
---

## What happened

<!-- A clear description. If a pruned result lost something you needed, say what
     was elided and whether the retrieval pointer (.ctxkeep/cache/...) recovered
     it. -->

## Expected

<!-- What you expected instead. -->

## Reproduce

Steps, ideally with the tool and roughly how large its output was:

1.
2.
3.

## Environment

- ctxkeep version / commit:
- Node version (`node --version`):
- OS:
- Relevant `.ctxkeep.json` overrides (if any):

## `ctxkeep doctor`

<!-- Paste the output of `ctxkeep doctor`. It reports config, injection size,
     and whether hooks have fired. -->

```
```

## Fail-open note

A broken ctxkeep is designed to look like *no* ctxkeep (exit 0, no output). If a
whole session broke, that's a fail-open bug — please include any stderr from
running with `CTXKEEP_DEBUG=1`.
