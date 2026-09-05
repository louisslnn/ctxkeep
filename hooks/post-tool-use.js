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
import { recordMetric, appendState, readState } from "../src/store.js";
import { estimateTokens } from "../src/tokenize.js";
import { fileIdentity, requestedRange } from "../src/dedupe.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled) return;

  // Dedupe route-around: the agent was denied a re-read, then fetched the same
  // path another way (a shell cat/sed/grep). That denial cost a turn and saved
  // nothing — the net-negative case. Recording it lets `stats` show whether
  // dedupe actually earns anything, instead of assuming every denial is a win.
  if (config.dedupe?.enabled && input.tool_name === "Bash") {
    const cmd = input.tool_input?.command || "";
    const routed = readState(config, input.session_id).denials?.find(
      (d) => d.path && cmd.includes(d.path),
    );
    if (routed) {
      recordMetric(config, {
        kind: "dedupe_routed",
        session: input.session_id,
        path: routed.path,
      });
    }
  }

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

  // Record the read so PreToolUse can dedupe a later read of the same lines.
  // Store the content hash and the delivered line range (file identity), so a
  // partial re-read of seen lines is caught and a new region is not. Appended as
  // its own log line so parallel PostToolUse calls don't clobber each other.
  if (config.dedupe?.enabled && filePath && input.tool_name === "Read") {
    let ident = null;
    try {
      ident = fileIdentity(filePath);
    } catch {
      /* file gone by now — record what we can, dedupe just won't match */
    }
    const [start, end] = ident
      ? requestedRange(input.tool_input?.offset, input.tool_input?.limit, ident.lineCount)
      : [null, null];
    appendState(config, input.session_id, {
      read: {
        path: filePath,
        at: Date.now(),
        tokens: result.originalTokens,
        cachedAt: result.cachedAt ?? null,
        hash: ident?.hash ?? null,
        start,
        end,
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
