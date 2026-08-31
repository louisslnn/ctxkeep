#!/usr/bin/env node
/**
 * PreToolUse — dedupe.
 *
 * Agents re-read the same file repeatedly across a long session. If the file
 * hasn't changed on disk since the last read in this session, there is no new
 * information in reading it again, only cost.
 *
 * This denies the call with a reason rather than rewriting the input, because
 * the reason text is what tells the model where the content already is. A deny
 * here is cheap and recoverable: the model reads the cached copy instead.
 */
import { statSync } from "node:fs";
import { readInput, emit, guard } from "../src/io.js";
import { loadConfig } from "../src/config.js";
import { readState, recordMetric } from "../src/store.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled || !config.dedupe?.enabled) return;
  if (input.tool_name !== "Read") return;

  const filePath = input.tool_input?.file_path;
  if (!filePath) return;
  if (config.passthroughPaths?.some((p) => filePath.includes(p))) return;

  // A partial read is a different request from the one we cached.
  if (input.tool_input?.offset || input.tool_input?.limit) return;

  const state = readState(config, input.session_id);
  const previous = state.reads?.[filePath];
  if (!previous) return;

  let mtime;
  try {
    mtime = statSync(filePath).mtimeMs;
  } catch {
    return; // file moved or gone — let the real tool report that
  }
  if (mtime > previous.at) return; // genuinely changed since we read it

  recordMetric(config, {
    kind: "dedupe",
    session: input.session_id,
    path: filePath,
    saved: previous.tokens ?? 0,
  });

  const where = previous.cachedAt
    ? ` The full text from that read is at ${previous.cachedAt}.`
    : "";

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `This file was already read in this session and has not changed on disk since.` +
        ` Its contents are already in the conversation above.${where}` +
        ` Re-read it only after editing it, or with an offset/limit for a specific range.`,
    },
  });
});
