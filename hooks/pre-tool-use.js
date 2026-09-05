#!/usr/bin/env node
/**
 * PreToolUse — dedupe.
 *
 * Agents revisit the same file across a long session — but with grep and offset
 * reads, not byte-identical whole-file re-reads. So dedupe keys on *file
 * identity* (path + content hash + the line ranges already delivered), not on
 * the exact call. A read is denied only when the file is unchanged and every
 * line it would return is already in the conversation above.
 *
 * Two safety rules (see src/dedupe.js): never deny a region the agent has not
 * seen yet, and never deny across a compaction that may have summarised the
 * earlier read away. A denial is recorded so PostToolUse can tell whether the
 * agent then routed around it (a shell read of the same path) — the net-negative
 * case where the denial cost a turn and saved nothing.
 */
import { readInput, emit, guard } from "../src/io.js";
import { loadConfig } from "../src/config.js";
import { readState, recordMetric, appendState } from "../src/store.js";
import { fileIdentity, requestedRange, dedupeDecision } from "../src/dedupe.js";
import { estimateTokens } from "../src/tokenize.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled || !config.dedupe?.enabled) return;
  if (input.tool_name !== "Read") return;

  const filePath = input.tool_input?.file_path;
  if (!filePath) return;
  if (config.passthroughPaths?.some((p) => filePath.includes(p))) return;

  const state = readState(config, input.session_id);
  const priorReads = state.reads?.[filePath];
  if (!priorReads || !priorReads.length) return;

  let id;
  try {
    id = fileIdentity(filePath);
  } catch {
    return; // moved or gone — let the real tool report that
  }

  const requested = requestedRange(
    input.tool_input?.offset,
    input.tool_input?.limit,
    id.lineCount,
  );

  const { deny } = dedupeDecision({
    priorReads,
    requested,
    currentHash: id.hash,
    compactedAt: state.compactedAt ?? 0,
  });
  if (!deny) return;

  // Tokens kept out of context: the region that would have been re-delivered.
  const region = id.content.split("\n").slice(requested[0] - 1, requested[1]).join("\n");
  const saved = estimateTokens(region);

  // Record the denial so a later shell read of this path counts as routed-around.
  appendState(config, input.session_id, {
    denied: { path: filePath, start: requested[0], end: requested[1], at: Date.now() },
  });
  recordMetric(config, {
    kind: "dedupe",
    session: input.session_id,
    path: filePath,
    start: requested[0],
    end: requested[1],
    saved,
  });

  const cachedAt = priorReads.map((r) => r.cachedAt).filter(Boolean).pop();
  const where = cachedAt ? ` The full text from that read is at ${cachedAt}.` : "";

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Lines ${requested[0]}–${requested[1]} were already read in this session and the file ` +
        `is unchanged on disk; they are already in the conversation above.${where}` +
        ` Re-read only after editing the file, or request a line range you have not read yet.`,
    },
  });
});
