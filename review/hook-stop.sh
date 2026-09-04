#!/usr/bin/env bash
# Stop hook: run review when the agent tries to finish its turn.
#
# THE LOOP GUARD IS THE WHOLE DESIGN.
#
# A Stop hook that always blocks creates an infinite loop: the agent tries to
# stop, the hook says keep going, the agent works, tries to stop, blocked
# again. Claude Code passes `stop_hook_active: true` when the hook fires
# because of a previous block — but it does NOT break the loop for you. You
# must check it and exit 0. Ignoring it burns quota until you notice.
#
# So this gives exactly ONE review-and-fix round per turn. That is deliberate.
# A reviewer that keeps finding things forever is usually finding nothing, and
# an unbounded loop is a quota incident, not a quality process.
#
# On the second pass the deterministic gate still runs — it costs nothing — and
# if it is still failing, that is escalated to a file for you rather than
# looped on.

set -uo pipefail

# RECURSION GUARD. review.sh spawns `claude -p`, and that nested session fires
# its own Stop hook when it finishes — which would spawn another reviewer,
# forever. review.sh exports CTXKEEP_IN_REVIEW; the child inherits it, and we
# bail out here. Without this the first review call recurses until you notice.
if [ "${CTXKEEP_IN_REVIEW:-}" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

active=$(printf '%s' "$INPUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).stop_hook_active || false' 2>/dev/null || echo false)

if [ "$active" = "true" ]; then
  # Second pass. Cannot block again. Verify cheaply and escalate if still bad.
  if ! bash review/gate.sh > /tmp/review-gate2.log 2>&1; then
    {
      echo "# Review escalation — $(date -Iseconds)"
      echo
      echo "The deterministic gate was still failing after one correction round."
      echo "The turn was allowed to end to avoid an infinite loop. Needs a human."
      echo
      cat /tmp/review-gate2.log
    } >> REVIEW_FAILED.md
    echo "Gate still failing after one round — escalated to REVIEW_FAILED.md" >&2
  fi
  exit 0
fi

# --- First pass ----------------------------------------------------------
REPORT=""

if ! GATE=$(bash review/gate.sh 2>&1); then
  REPORT="$GATE"
fi

# Only pay for the LLM reviewer once the free checks are clean. Reviewing a
# diff whose tests don't pass wastes a model call on a known-bad change.
if [ -z "$REPORT" ]; then
  if ! LLM=$(bash review/review.sh "${REVIEW_BASE:-HEAD}" 2>&1); then
    REPORT="$LLM"
  fi
fi

if [ -z "$REPORT" ]; then
  exit 0
fi

node -e '
const reason = process.argv[1];
process.stdout.write(JSON.stringify({
  decision: "block",
  reason:
    "Review found problems with this turn. Fix them before finishing.\n\n" +
    reason +
    "\n\nAddress each finding. If you believe a finding is wrong, say why " +
    "explicitly rather than ignoring it. Do not weaken a test to clear a " +
    "finding. You get one correction round — the next stop will not be blocked."
}));' "$REPORT"
exit 0
