#!/usr/bin/env bash
# Deterministic review gate. No LLM, no network, no cost.
#
# Most of what goes wrong in an unattended run is mechanically detectable.
# Check it here, for free, before spending a model call on judgment. An LLM
# reviewer asked to check things a script can check will do it worse, slower,
# and inconsistently.
#
# Exit 0 = clean. Exit 1 = findings on stdout.

set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

BASE="${REVIEW_BASE:-HEAD}"
FINDINGS=()
add() { FINDINGS+=("$1"); }

# --- 1. The hard gates ---------------------------------------------------
if ! npm test >/tmp/review-test.log 2>&1; then
  add "TESTS FAIL. Last 20 lines:
$(tail -20 /tmp/review-test.log)"
fi

if ! npm run eval >/tmp/review-eval.log 2>&1; then
  add "EVAL GATE FAILS — a critical pattern was lost. This is never acceptable. Output:
$(tail -20 /tmp/review-eval.log)"
fi

# --- 2. Tests must be added, not weakened --------------------------------
# The most common way an unattended run produces a green gate that means
# nothing. Any net deletion inside test/ is worth a human look.
TEST_DIFF=$(git diff "$BASE" --numstat -- test/ 2>/dev/null)
if [ -n "$TEST_DIFF" ]; then
  while read -r added removed file; do
    [ -z "${file:-}" ] && continue
    if [ "$removed" != "0" ] && [ "$removed" -gt "$added" ] 2>/dev/null; then
      add "WEAKENED TEST: $file removed $removed lines, added $added. Tests should grow, not shrink. Justify or revert."
    fi
  done <<<"$TEST_DIFF"
fi

# Assertion count is a blunter but harder-to-game signal than line count.
BEFORE=$(git show "$BASE":test/prune.test.js 2>/dev/null | grep -c "assert\." || echo 0)
AFTER=$(grep -c "assert\." test/prune.test.js 2>/dev/null || echo 0)
if [ "$AFTER" -lt "$BEFORE" ]; then
  add "ASSERTIONS REMOVED: test/prune.test.js went from $BEFORE to $AFTER assertions."
fi

# --- 3. No new runtime dependencies --------------------------------------
if git diff "$BASE" -- package.json 2>/dev/null | grep -qE '^\+.*"(dependencies)"'; then
  add "package.json dependencies block was touched. Hooks spawn per tool call; runtime deps are a latency budget item and need explicit sign-off."
fi
DEPS=$(node -p "Object.keys(require('./package.json').dependencies||{}).length" 2>/dev/null || echo 0)
if [ "$DEPS" != "0" ]; then
  add "Runtime dependencies present ($DEPS). This project is intentionally dependency-free."
fi

# --- 4. Foreign artifacts ------------------------------------------------
if git ls-files | grep -qiE '\.vsix$|kickbacks'; then
  add "Foreign artifacts still tracked (vsix / kickbacks). See TASKS.md 0.3."
fi

# --- 5. Invariant tripwires ----------------------------------------------
# Cheap greps for the two invariants whose violation is textually visible.
if git diff "$BASE" -- src/ hooks/ | grep -qE '^\+.*(fetch\(|https?://|anthropic|api\.)' ; then
  add "A network call or API reference was added under src/ or hooks/. Invariant 7: no model calls in a hook."
fi
if git diff "$BASE" -- src/prune/ | grep -qE '^\-.*(stashArtifact|pointer)'; then
  add "Artifact stashing or the retrieval pointer was removed from the prune path. Invariant 2: pruning must be reversible."
fi

# --- 6. One task per commit ----------------------------------------------
if [ "$BASE" != "HEAD" ]; then
  TASKS_REFERENCED=$(git log "$BASE"..HEAD --pretty=%s | grep -oE '\b[0-9]\.[0-9]\b' | sort -u | wc -l)
  COMMITS=$(git rev-list --count "$BASE"..HEAD)
  if [ "$COMMITS" -gt 0 ] && [ "$TASKS_REFERENCED" -eq 0 ]; then
    add "No commit since $BASE references a task number. TASKS.md asks for one task per commit, referenced in the message."
  fi
fi

# --- report --------------------------------------------------------------
if [ ${#FINDINGS[@]} -eq 0 ]; then
  echo "gate: clean"
  exit 0
fi

echo "DETERMINISTIC GATE FAILED (${#FINDINGS[@]} finding(s)):"
printf '%s\n' ""
for f in "${FINDINGS[@]}"; do
  printf '  • %s\n\n' "$f"
done
exit 1
