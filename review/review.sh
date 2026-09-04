#!/usr/bin/env bash
# Independent code review of the working diff.
#
# THE POINT IS INDEPENDENCE. This spawns a separate `claude -p` process with a
# fresh context window. The agent that wrote the code has already justified
# every decision it made — asking it to review its own work in the same
# context produces agreement, not review.
#
# A subagent is better than nothing (separate context) but still reports back
# to the agent that decided what to build, which then decides whether to care.
# A separate process reviewing a diff it has no history with is the real thing.
#
# Usage:  review/review.sh [base-ref]
# Writes: review/findings/<timestamp>.json, and a human summary to stdout.
# Exit:   0 if verdict is "pass", 1 otherwise.

set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

BASE="${1:-${REVIEW_BASE:-HEAD}}"
MODEL="${REVIEW_MODEL:-claude-sonnet-4-6}"
OUT_DIR="review/findings"
mkdir -p "$OUT_DIR"

DIFF=$(git diff "$BASE" -- . ':(exclude)review/findings')
if [ -z "$DIFF" ]; then
  echo "review: no changes to review"
  exit 0
fi

# Keep the diff bounded. A reviewer given 40k lines reviews none of them.
DIFF_LINES=$(printf '%s' "$DIFF" | wc -l)
if [ "$DIFF_LINES" -gt 3000 ]; then
  echo "review: diff is $DIFF_LINES lines — too large for one review pass."
  echo "This usually means several tasks were batched into one change. Split it."
  exit 1
fi

INVARIANTS=$(sed -n '/## Invariants/,/## Do not do/p' CLAUDE.md 2>/dev/null)
RECENT=$(git log "$BASE"..HEAD --pretty='%s' 2>/dev/null | head -10)

PROMPT=$(cat <<'EOF'
You are reviewing a diff for a Claude Code context-management tool. You did not
write this code and have no stake in it being correct.

Your job is to find defects, not to approve. Assume the change is wrong and look
for why. If you find nothing, say so plainly — a clean verdict is a real result,
but reaching one by not looking is not.

Report ONLY findings you can tie to a specific line or hunk. Do not report:
- style, naming, or formatting preferences
- suggestions to add comments
- speculative refactors
- anything a linter would catch

Weight these heavily, in order:
1. VIOLATED INVARIANT — the project invariants below are load-bearing. A
   violation is always blocking.
2. WRONG BEHAVIOUR — the code does not do what the commit message claims, or
   does it only for the happy path.
3. TEST THAT CANNOT FAIL — an assertion that passes regardless of the fix,
   a test asserting the mock rather than the code, a removed assertion.
   Treat a test added alongside a fix with particular suspicion: it was
   written by whoever wrote the fix, and it is supposed to fail without it.
4. SILENT FAILURE — an error swallowed in a path where the fail-open rule
   does not apply, or a code path that degrades with no signal.

Respond with ONLY a JSON object, no prose or code fences:
{
  "verdict": "pass" | "fail",
  "findings": [
    {"severity": "blocking"|"concern", "file": "path", "line": "N or hunk", "issue": "what is wrong", "why": "the consequence"}
  ],
  "summary": "one or two sentences"
}
Set verdict to "fail" if there is at least one blocking finding.
EOF
)

FULL=$(printf '%s\n\n## Project invariants\n%s\n\n## Recent commit messages\n%s\n\n## Diff (base: %s)\n```diff\n%s\n```\n' \
  "$PROMPT" "$INVARIANTS" "$RECENT" "$BASE" "$DIFF")

# Marks the nested session so its Stop hook bails out instead of recursing.
export CTXKEEP_IN_REVIEW=1

RESPONSE=$(printf '%s' "$FULL" | claude -p --model "$MODEL" --output-format json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).result||"")}catch{process.stdout.write("")}})')

if [ -z "$RESPONSE" ]; then
  echo "review: reviewer produced no output — treating as inconclusive, not as a pass."
  exit 1
fi

CLEAN=$(printf '%s' "$RESPONSE" | sed 's/^```json//; s/^```//; s/```$//')
STAMP=$(date +%Y%m%d-%H%M%S)
printf '%s' "$CLEAN" > "$OUT_DIR/$STAMP.json"

VERDICT=$(printf '%s' "$CLEAN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.verdict||"unparseable")}catch{console.log("unparseable")}})')

if [ "$VERDICT" = "pass" ]; then
  echo "review: pass"
  exit 0
fi

echo "INDEPENDENT REVIEW: $VERDICT"
printf '%s' "$CLEAN" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s);
    console.log("\n" + (j.summary||"") + "\n");
    for(const f of (j.findings||[])){
      console.log(`  [${f.severity}] ${f.file}:${f.line}`);
      console.log(`    ${f.issue}`);
      console.log(`    → ${f.why}\n`);
    }
  }catch{ console.log(s.slice(0,2000)); }
});'
exit 1
