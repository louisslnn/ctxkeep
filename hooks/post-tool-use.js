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
import { recordMetric, readState, writeState } from "../src/store.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled) return;

  const text = extractText(input.tool_response);
  if (!text || typeof text !== "string") return;

  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";

  const result = pruneToolOutput({
    config,
    toolName: input.tool_name,
    toolUseId: input.tool_use_id,
    text,
    filePath,
  });

  // Record the read so PreToolUse can dedupe a repeat of the same file.
  if (config.dedupe?.enabled && filePath) {
    const state = readState(config, input.session_id);
    state.reads[filePath] = {
      at: Date.now(),
      tokens: result.originalTokens,
      cachedAt: result.cachedAt ?? null,
    };
    writeState(config, input.session_id, state);
  }

  if (!result.pruned) return;

  recordMetric(config, {
    kind: "prune",
    session: input.session_id,
    tool: input.tool_name,
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
