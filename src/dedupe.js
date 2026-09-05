/**
 * Dedupe — recognise a re-read of file content already in context.
 *
 * The original rule keyed on *call* identity (exact path, no offset/limit) and
 * exempted every partial read. Agents revisit files with grep and offset reads,
 * so it essentially never fired (dedupe 0 across four calibrations). This keys
 * on *file* identity instead: a content hash plus the line ranges already
 * delivered this session. A read is a duplicate only when the file is unchanged
 * (same hash) AND every line it would return has already been delivered.
 *
 * Two safety rules are baked into `dedupeDecision`:
 *   1. Never deny a region the agent has not seen — deny only when the request
 *      is fully covered by prior ranges. A partial read that reaches new lines
 *      is allowed.
 *   2. Never deny across a compaction — a read recorded before the last
 *      compaction may have been summarised out of context, so its content is no
 *      longer there to reference. Those records are ignored.
 *
 * The functions here are pure so the decision is unit-testable; the hook does
 * only the fs/emit work around them.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Claude Code's Read returns at most this many lines when no limit is given.
export const WHOLE_READ_CAP = 2000;

/** Content hash + line count, read fresh from disk. Throws if the file is gone
 *  (the caller fails open — a missing file is the real tool's problem). */
export function fileIdentity(path) {
  const content = readFileSync(path, "utf8");
  return {
    hash: createHash("sha1").update(content).digest("hex"),
    lineCount: content.split("\n").length,
    content,
  };
}

/** The 1-based inclusive line range a Read(offset, limit) delivers over a file
 *  of `lineCount` lines. Offset is a 1-based start line; no limit runs to EOF
 *  (capped at the Read line cap). */
export function requestedRange(offset, limit, lineCount, cap = WHOLE_READ_CAP) {
  const start = offset && offset > 0 ? offset : 1;
  const end =
    limit && limit > 0
      ? Math.min(start + limit - 1, lineCount)
      : Math.min(lineCount, start - 1 + cap);
  return [start, Math.max(start, end)];
}

/** Is [s, e] fully covered by the union of `ranges` ([start, end] pairs)? */
export function coveredBy([s, e], ranges) {
  const sorted = (ranges || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  let cursor = s;
  for (const [rs, re] of sorted) {
    if (rs > cursor) break; // a gap opens before the cursor — cannot be covered
    if (re >= cursor) cursor = re + 1;
    if (cursor > e) return true;
  }
  return cursor > e;
}

/**
 * Decide whether a Read should be denied as already-in-context.
 * @param priorReads array of { hash, start, end, at } recorded this session
 * @param requested  [start, end] the pending read would deliver
 * @param currentHash content hash of the file on disk right now
 * @param compactedAt timestamp of the last compaction (0 if none)
 */
export function dedupeDecision({ priorReads, requested, currentHash, compactedAt = 0 }) {
  const relevant = (priorReads || []).filter(
    (r) =>
      r.hash === currentHash &&
      r.start != null &&
      (r.at ?? 0) > (compactedAt ?? 0),
  );
  if (!relevant.length) return { deny: false };
  return { deny: coveredBy(requested, relevant.map((r) => [r.start, r.end])) };
}
