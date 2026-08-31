#!/usr/bin/env node
/**
 * SessionStart — put memory back.
 *
 * Matches on `startup`, `resume`, `clear`, `compact` and `fork`. The `compact`
 * case is the important one: it fires after compaction has discarded the
 * conversation, which is exactly the moment the accumulated knowledge needs to
 * be re-established.
 *
 * This runs on every session, so it must stay fast — a file read and a string
 * trim, nothing more.
 */
import { readInput, emit, guard } from "../src/io.js";
import { loadConfig } from "../src/config.js";
import { buildDigest } from "../src/memory.js";
import { appendState } from "../src/store.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled) return;

  // Stamp the session start time. PreCompact reads this to tell whether the
  // memory file was touched *this* session; without it that check runs against
  // epoch and the compaction gate never fires. Written before the digest early
  // return so the gate works even when memory is still the empty template.
  appendState(config, input.session_id, { startedAt: Date.now() });

  const digest = buildDigest(config);
  if (!digest) return;

  emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: digest,
    },
  });
});
