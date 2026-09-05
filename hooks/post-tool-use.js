#!/usr/bin/env node
/**
 * PostToolUse — the main event.
 *
 * Intercepts a tool result after the tool ran but before the text lands in the
 * context window, and replaces it via `updatedToolOutput`. This is where most
 * of the savings come from: in an agentic coding session, file reads and
 * command output typically dwarf the conversation itself.
 *
 * Shaping content on the way IN is cache-safe. Never rewrite turns that are
 * already in history — that invalidates the cached prefix and costs more than
 * it saves.
 */
import { readInput, emit, guard, extractText, replaceText } from "../src/io.js";
import { loadConfig } from "../src/config.js";
import { pruneToolOutput } from "../src/prune/index.js";
import { recordMetric, appendState } from "../src/store.js";
import { estimateTokens } from "../src/tokenize.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled) return;

  const text = extractText(input.tool_response);
  if (!text || typeof text !== "string") return;

  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";

  // A read of a cached artifact is an *expansion*: the model decided a pruned
  // middle mattered and pulled the full text back in. That is the fidelity cost
  // of pruning, and the only place it is observable — the cache is a
  // passthrough path, so it is never itself pruned or recorded below. Log it so
  // `stats` can report the re-fetch rate and net (gross saving − re-fetch cost).
  // `of` is the original prune's tool_use_id (the artifact's basename), so a
  // re-fetch can be matched back to the exact prune it undid.
  const cacheMark = `${config.cacheDir}/cache/`;
  if (input.tool_name === "Read" && filePath.includes(cacheMark)) {
    recordMetric(config, {
      kind: "refetch",
      session: input.session_id,
      path: filePath,
      of: filePath.split("/").pop()?.replace(/\.txt$/, "") || undefined,
      tokens: estimateTokens(text),
    });
    return;
  }

  const result = pruneToolOutput({
    config,
    toolName: input.tool_name,
    toolUseId: input.tool_use_id,
    text,
    filePath,
  });

  // Record the read so PreToolUse can dedupe a repeat of the same file.
  // Appended as its own log line so parallel PostToolUse hooks don't clobber.
  if (config.dedupe?.enabled && filePath) {
    appendState(config, input.session_id, {
      read: {
        path: filePath,
        at: Date.now(),
        tokens: result.originalTokens,
        cachedAt: result.cachedAt ?? null,
      },
    });
  }

  if (!result.pruned) return;

  recordMetric(config, {
    kind: "prune",
    session: input.session_id,
    tool: input.tool_name,
    // The artifact is stored under this id; a later refetch carries it in `of`,
    // which is how a prune and its expansion are matched for the net accounting.
    id: input.tool_use_id,
    path: filePath || undefined,
    before: result.originalTokens,
    after: result.newTokens,
    saved: result.saved,
  });

  emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: replaceText(input.tool_response, result.text),
    },
  });
});
