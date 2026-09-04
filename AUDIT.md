# AUDIT.md — Phase 1 audit

Run with the review harness now present in the tree. **Report only — nothing is
fixed in this document.** Blocking findings are fixed in follow-up commits (see
step 2); non-blocking findings are left here.

## How it was run

```sh
bash review/gate.sh
REVIEW_BASE=34b7249 bash review/review.sh 34b7249
```

- **`gate.sh` → clean (exit 0).** Deterministic checks pass: tests green, eval
  gate green, no weakened tests, no assertion-count drop, zero runtime deps, no
  foreign artifacts, no invariant tripwires, commits reference task numbers.

- **`review.sh 34b7249` → bailed on size (exit 1).** The branch has advanced
  well past Phase 1, so `34b7249..HEAD` is 5161 lines — over the harness's
  3000-line cap ("too large for one review pass … Split it"). The reviewer
  refused rather than skim a batched diff. That is the reviewer working as
  designed, not a Phase 1 finding.

- **Scoped re-run against Phase 1 only → verdict `pass`, no findings.** To get
  the independent review the command was meant for, I checked out `08dc9b5` (end
  of Phase 1) in a throwaway git worktree and ran `review.sh` with base
  `34b7249`, giving a 2040-line diff of exactly the six Phase 1 commits. The
  independent reviewer (`claude-sonnet-4-6`, fresh context) returned
  `{"verdict":"pass","findings":[]}` — saved at
  `review/findings/20260904-120252.json`.
  - Caveat on that reviewer: it emitted prose before the JSON, so `review.sh`
    printed `unparseable` to stdout even though the written verdict is a clean
    pass. Minor harness robustness note, not a code defect.
  - The reviewer *did* remark on the `replaceText` Read shape but scoped it out
    ("pre-existing, untouched by the diff") — correct — while asserting "the
    model still receives the pruned text", which is **wrong** (empirically it did
    not; that is exactly the delivery bug fixed in `14667e4`). A function-diff
    reviewer cannot see a delivery failure. This is the motivation for step 3.

## Mandated hand-checks (done regardless of the reviewer's verdict)

### (a) 1.3 cache sweep vs invariant 2 — **BLOCKING**

`hooks/session-start.js` calls `sweepCache(config)` **unconditionally**; it never
inspects `input.source`. The SessionStart matcher is `startup|resume|compact|
fork`, so the sweep runs on **`resume`** too.

Demonstrated live (10-day-old artifact, `retentionDays` default 7):

```
before: artifact exists = true
session-start (source=resume) exit: 0
after resume: artifact exists = false   ← pointer in the resumed conversation now dangles
```

A resumed session's conversation already contains pruned tool results whose
`[ctxkeep]` pointers reference `.ctxkeep/cache/*.txt`. If those prunes are older
than the retention window, the sweep **deletes them on the very resume that
brings them back into context** — the elided middle becomes unrecoverable. That
is the reversibility invariant (invariant 2: "a prune without a [live] pointer is
data loss") broken for resumed sessions.

Does expansion fail gracefully when the file is gone? **Yes, but lossy.**
`ctxkeep expand <id>` on a missing artifact exits 1 with `No cached artifact for
<id>` (no crash, no hang); a direct `Read` of the missing cache path returns a
file-not-found from the tool. So the session is not broken — but the content is
gone. Graceful failure limits the blast radius; it does not restore reversibility.

**Fix (step 2):** the sweep must skip `resume` (and any source that continues an
existing conversation) — sweep only on a fresh `startup`, so a session never has
artifacts its own live pointers reference deleted out from under it.

### (b) 1.2 append-only state replay cost — **not blocking**

`readState` replays the whole append-only log and runs on the PreToolUse hot
path (every `Read`, for the dedupe decision) and in PreCompact. Measured
(20-run average, `src/store.js` `readState`):

| entries | ms / readState |
|--------:|---------------:|
|   1,000 |          0.99  |
|  10,000 |          9.29  |
| 100,000 |         99.98  |

Linear O(n), ~1 ms per 1,000 entries. The log is **per-session** (keyed by
`session_id`), so it only grows within one session. At realistic single-session
sizes (≤10k reads) replay is ≤9 ms — below the hook's own node process-spawn
overhead (~30 ms+), which dominates. It only becomes material at ~100k
reads/session, which does not happen. **No log compaction is needed at realistic
scale.**

Minor related note (non-blocking): `sweepCache` only sweeps `cache/`, so
per-session `state/*.log` files (and `transcripts/`) are never garbage
collected. A disk-housekeeping gap, not a hot-path or correctness issue.

## Verdict

One blocking finding: **(a) the cache sweep runs on `resume` and can delete
artifacts a resumed session still points at.** Fixed next, failing test first.
Everything else — the deterministic gate, the scoped independent review, and
hand-check (b) — is clean or non-blocking.
