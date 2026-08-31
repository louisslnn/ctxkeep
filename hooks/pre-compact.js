#!/usr/bin/env node
/**
 * PreCompact — the last chance to save anything.
 *
 * Compaction is where hard-won context goes to die. This hook does two things:
 *
 *  1. Always: snapshot the transcript to disk, so the pre-compaction detail is
 *     recoverable even though it is leaving the context window.
 *
 *  2. Optionally (`memory.blockCompactUntilRecorded`): block the first
 *     compaction of a session if the memory file hasn't been touched, with a
 *     reason telling Claude to record what it learned. Claude writes memory,
 *     compaction retries, and this time it passes.
 *
 * The blocking path is off by default and fires at most once per session. A
 * gate on compaction that can trigger repeatedly will wedge a session against
 * a full context window, which is a far worse outcome than a lost decision.
 */
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readInput, emit, guard } from "../src/io.js";
import { loadConfig } from "../src/config.js";
import { readState, appendState, recordMetric } from "../src/store.js";
import { memoryPath } from "../src/memory.js";

guard(async () => {
  const input = await readInput();
  const config = loadConfig(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!config.enabled) return;

  const state = readState(config, input.session_id);

  // 1. Snapshot the transcript.
  if (input.transcript_path && existsSync(input.transcript_path)) {
    try {
      const dest = join(
        config.cacheRoot,
        "transcripts",
        `${input.session_id}-${Date.now()}.jsonl`,
      );
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(config.cacheRoot, "transcripts"), { recursive: true });
      copyFileSync(input.transcript_path, dest);
      recordMetric(config, {
        kind: "compact",
        session: input.session_id,
        trigger: input.trigger,
        snapshot: dest,
      });
    } catch {
      /* snapshot is best-effort */
    }
  }

  // 2. Optional one-shot gate.
  if (!config.memory?.blockCompactUntilRecorded) return;
  if (state.compactGateUsed) return;

  const path = memoryPath(config);
  const sessionStarted = state.startedAt ?? 0;
  const touchedThisSession = existsSync(path) && statSync(path).mtimeMs > sessionStarted;
  if (touchedThisSession) return;

  appendState(config, input.session_id, { compactGateUsed: true });

  emit({
    decision: "block",
    reason:
      `Context is about to be compacted and ${config.memory.file} has not been updated this session. ` +
      `Before compaction, record anything durable that was learned: decisions and their reasons, ` +
      `constraints discovered, and approaches ruled out. Skip anything already written there, ` +
      `and skip transient detail. Then compaction can proceed.`,
  });
});
