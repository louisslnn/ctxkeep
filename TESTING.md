# Testing ctxkeep

ctxkeep has two things worth verifying, and they answer different questions:

- **Unit tests** (`npm test`) — *is the pruning logic correct?* Fast, deterministic,
  no Claude Code required.
- **Eval dashboard** (`npm run eval`) — *is the pruning worth it?* Renders a
  terminal table of token savings **and** whether anything load-bearing was
  destroyed to get them. Savings alone are meaningless; you can hit any
  compression number by deleting more.

A third check, `ctxkeep doctor` / `ctxkeep stats`, verifies a *live* install
inside a real Claude Code session.

Requirements: Node ≥ 20. No dependencies to install.

---

## 1. Unit tests

```bash
npm test
```

Runs `node --test` over `test/*.test.js`. Expected:

```
✔ short output passes through untouched
✔ long output is pruned and gains a retrieval pointer
✔ cache reads are never pruned, so expansion cannot loop
✔ tools on the neverPrune list are skipped
✔ error lines survive even when buried mid-output
✔ elision markers report how much was removed
✔ extractText handles the shapes a tool_response can take
✔ replaceText preserves the original response shape
ℹ tests 8   ℹ pass 8   ℹ fail 0
```

Run a single test by name:

```bash
node --test --test-name-pattern="error lines survive" test/prune.test.js
```

---

## 2. The token-optimization dashboard

```bash
npm run eval
```

This is the dashboard. It replays a set of fixtures — captured tool output —
through the real pruner and prints what it saved and what it kept:

```
fixture                     before   after   saved   inline  lost
-----------------------------------------------------------------
bash-short-passthrough          21      21      0%      2/2     0
bash-test-run-failure         2.5k    1.3k     47%      4/4     0
read-large-source            35.0k    2.0k     94%      3/3     0
-----------------------------------------------------------------
TOTAL                        37.5k    3.3k     91%      9/9     0
```

### Reading the columns

| Column | Meaning |
|---|---|
| `before` / `after` | Estimated tokens entering context, before and after pruning. |
| `saved` | Percentage reduction. Higher is better **only if `lost` stays 0**. |
| `inline` | `kept / total` critical patterns still visible *without* a follow-up read. |
| `lost` | Critical patterns that are neither in the pruned text nor recoverable from the cache pointer. **Any value above 0 is a bug** — the harness exits non-zero. |

`bash-short-passthrough` saving 0% is correct: output under the line threshold
is passed through untouched. Pruning it would be pure overhead.

Token counts are a character-ratio heuristic (`src/tokenize.js`), not real
tokenizer output — directionally right, not exact.

### Exit code

`npm run eval` exits `1` if any fixture loses a critical line, so it drops
straight into CI:

```bash
npm run eval || echo "regression: a critical line was pruned away"
```

---

## 3. Add your own fixtures

The bundled fixtures are tuned for JS/TS output and will not transfer cleanly
to other stacks. The point of the dashboard is to tune against *your* real
output, so capture some and drop it in `eval/fixtures/`.

Each fixture is one JSON file. Inline the body with `text`, or point at a
sibling file with `textFile` for anything large:

```json
{
  "name": "pytest-failure",
  "tool": "Bash",
  "textFile": "pytest-failure.txt",
  "critical": [
    "FAILED tests/test_auth.py::test_login",
    "assert 200 == 401",
    "1 failed, 214 passed"
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Row label in the dashboard. |
| `tool` | yes | Which prune rule applies: `Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, or any name (falls back to the `default` rule). |
| `text` *or* `textFile` | yes | The captured output. `textFile` is resolved relative to `eval/fixtures/`. |
| `filePath` | no | Simulates the path of a `Read`. Paths under `.ctxkeep/` are treated as cache and never pruned. |
| `critical` | no | Regex patterns (matched with the `m` flag) that MUST survive. This is what turns a savings number into a real measurement. |

**Capture real output** by logging a hook payload for one session, then lift the
`tool_response` text into a fixture:

```bash
echo '{"hooks":{"PostToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"cat >> /tmp/ctxkeep-shapes.jsonl"}]}]}}' \
  > .claude/settings.local.json
```

Choose `critical` patterns for the lines that were the *reason you ran the
command* — the failing assertion, the one changed signature, the error summary.
If the pruner elides one, the dashboard will show it in `lost` and list it below
the table.

### Tuning

Prune thresholds live in `src/config.js` (`DEFAULTS.prune`), overridable per
project via `.ctxkeep.json`. Edit a rule, re-run `npm run eval`, and watch the
`saved` and `lost` columns move together. The goal is the highest `saved` that
keeps `lost` at 0.

---

## 4. Verify a live install

The unit tests and dashboard exercise the pruning logic in isolation. To confirm
the hooks actually fire inside Claude Code:

```bash
ctxkeep doctor    # hooks registered? CONTEXT.md present? cache gitignored? hooks fired?
```

Then run a session that reads a large file, and check the savings ledger the
hooks recorded:

```bash
ctxkeep stats
```

```
ctxkeep — 1 session(s)

  pruned      3 results, saved ~34.2k tokens
  re-fetched  0 expansions, cost ~0 tokens
  compactions 0 snapshotted

  net prune   ~34.2k tokens (gross saved − re-fetched)
```

`stats` reads the metrics ledger written by the live hooks; it stays empty until
the hooks have fired at least once in a real session.

---

## Quick reference

| Command | Question it answers | Needs Claude Code? |
|---|---|---|
| `npm test` | Is the pruning logic correct? | no |
| `npm run eval` | How much does it save, and does it destroy anything? | no |
| `ctxkeep doctor` | Is the install wired up correctly? | yes |
| `ctxkeep stats` | What has it saved in real sessions? | yes |
