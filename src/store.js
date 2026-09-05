import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Everything ctxkeep persists lives under <projectRoot>/.ctxkeep/:
 *
 *   cache/<tool_use_id>.txt   full artifact, so pruning is reversible
 *   state/<session_id>.log    per-session event log (append-only)
 *   metrics.jsonl             append-only savings ledger
 *
 * Session state is an APPEND-ONLY log, not a read-modify-write JSON blob.
 * Claude Code runs tools in parallel, so several PostToolUse hooks race to
 * record their reads at once. A read → mutate → write of one shared file lets
 * the last writer clobber every entry added since it read, and dedupe then
 * silently misses files. Appending one line per event sidesteps that: each hook
 * only ever adds its own line (an O_APPEND write, atomic for small records),
 * and readState reconstructs the current state by replaying the log.
 */

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cachePath(config, toolUseId) {
  const safe = String(toolUseId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(ensure(join(config.cacheRoot, "cache")), `${safe}.txt`);
}

/** Write the full artifact to disk so the model can retrieve it on demand. */
export function stashArtifact(config, toolUseId, text) {
  const path = cachePath(config, toolUseId);
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * Age-based sweep of the artifact cache. Nothing else ever deletes these files,
 * so a long-lived project would accumulate thousands. Runs on SessionStart —
 * NEVER on PostToolUse, which is the hot path — and only touches files past the
 * configured retention window. Best-effort: a failed unlink is skipped, never
 * fatal. Returns the number of files removed. `retentionDays <= 0` disables it.
 */
export function sweepCache(config, now = Date.now()) {
  const days = config.cache?.retentionDays;
  if (!days || days <= 0) return 0;
  const dir = join(config.cacheRoot, "cache");
  if (!existsSync(dir)) return 0;

  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && st.mtimeMs < cutoff) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      /* file vanished or is unreadable — leave it */
    }
  }
  return removed;
}

function statePath(config, sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(ensure(join(config.cacheRoot, "state")), `${safe}.log`);
}

/** Replay the append-only event log into the current session state. */
export function readState(config, sessionId) {
  const state = { reads: {}, denials: [], turns: 0, compactedAt: 0 };
  const path = statePath(config, sessionId);
  if (!existsSync(path)) return state;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return state;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // a torn line from a crashed write — skip it, keep replaying
    }
    if (ev.read && ev.read.path) {
      // A list, not a single record: dedupe unions the line ranges already
      // delivered for a file (path+content identity), so a partial re-read of
      // seen lines is caught while a new region is not.
      (state.reads[ev.read.path] ??= []).push({
        at: ev.read.at,
        tokens: ev.read.tokens,
        cachedAt: ev.read.cachedAt ?? null,
        hash: ev.read.hash ?? null,
        start: ev.read.start ?? null,
        end: ev.read.end ?? null,
      });
    }
    if (ev.denied && ev.denied.path) state.denials.push(ev.denied);
    if ("compactedAt" in ev) state.compactedAt = Math.max(state.compactedAt, ev.compactedAt);
    if ("startedAt" in ev) state.startedAt = ev.startedAt;
    if (ev.compactGateUsed) state.compactGateUsed = true;
  }
  return state;
}

/**
 * Append one event to the session log. Concurrency-safe: every hook only ever
 * adds its own line, so parallel PostToolUse calls cannot clobber each other.
 */
export function appendState(config, sessionId, event) {
  try {
    appendFileSync(statePath(config, sessionId), JSON.stringify(event) + "\n", "utf8");
  } catch {
    /* state is an optimization, never fail the hook over it */
  }
}

export function recordMetric(config, entry) {
  if (!config.metrics?.enabled) return;
  try {
    ensure(config.cacheRoot);
    appendFileSync(
      join(config.cacheRoot, "metrics.jsonl"),
      JSON.stringify({ ts: Date.now(), ...entry }) + "\n",
      "utf8",
    );
  } catch {
    /* metrics are best-effort */
  }
}

export function readMetrics(config) {
  const path = join(config.cacheRoot, "metrics.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
