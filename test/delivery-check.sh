#!/usr/bin/env bash
# Genuine end-to-end DELIVERY check.
#
# This is deliberately NOT part of `npm test`. It needs a live `claude` process
# (a model call, the network, a non-deterministic session) — everything the
# hermetic test suite must not depend on. Run it by hand before a release, or
# after touching src/io.js (`replaceText`) or hooks/post-tool-use.js.
#
# WHY IT EXISTS. Every function-level test measures what the hook EMITS. None
# can see what Claude Code DELIVERS to the model. The replaceText Read bug — a
# bare-string `updatedToolOutput` that Claude Code silently dropped for the
# nested Read shape — passed all 36 unit tests and 7 eval fixtures precisely
# because they all stopped at the hook's output. The only way to catch a
# delivery failure is to run a real Read through a real session and read the
# transcript to see what actually landed in the model's context.
#
# It fails if a hook's emitted shape stops being accepted by Claude Code: if the
# pruned Read never reaches the model, the transcript has no [ctxkeep] pointer.
#
# Exit: 0 = pruning reached the model. 1 = it did not (delivery failure).
#       2 = could not run (no claude CLI / no session id).

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

command -v claude >/dev/null 2>&1 || { echo "SKIP: no 'claude' CLI on PATH."; exit 2; }
command -v node   >/dev/null 2>&1 || { echo "SKIP: no 'node' on PATH.";       exit 2; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# 600 lines is over the Read rule's maxLines (400), so a correct pipeline MUST
# prune it. Each line is uniquely tagged so a full (undelivered-prune) result is
# unmistakable from a pruned one.
awk 'BEGIN{for(i=1;i<=600;i++) printf "DLINE_%04d end-to-end delivery check\n", i}' > "$WORK/big.txt"

mkdir -p "$WORK/.claude"
cat > "$WORK/.claude/settings.json" <<JSON
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "node", "args": ["$REPO/hooks/post-tool-use.js"], "timeout": 15 }
        ]
      }
    ]
  }
}
JSON

cd "$WORK"
echo "Running a real Read through claude -p (this costs one model call)…"
OUT="$(CLAUDE_PROJECT_DIR="$WORK" claude -p --output-format json \
  "Read the file ./big.txt in full, then reply with exactly: DONE" 2>/dev/null)"

SID="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).session_id||"")}catch{console.log("")}})')"
[ -z "$SID" ] && { echo "SKIP: claude -p returned no session_id (auth? output format?)."; exit 2; }

# Locate the transcript by session id, robust to cwd path-encoding differences.
TRANSCRIPT="$(find "$HOME/.claude/projects" -name "$SID.jsonl" 2>/dev/null | head -1)"
[ -f "$TRANSCRIPT" ] || { echo "SKIP: transcript for $SID not found."; exit 2; }

# Inspect the SPECIFIC Read tool_result the model consumed — not a grep of the
# whole transcript. A grep for [ctxkeep] cannot fail when delivery breaks,
# because the pointer string appears elsewhere in the log; only matching the Read
# tool_use to its delivered tool_result tells you what actually reached the model.
node "$REPO/test/delivery-detect.mjs" "$TRANSCRIPT" "big.txt"
exit $?
