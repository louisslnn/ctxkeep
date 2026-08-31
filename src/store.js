import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
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

function statePath(config, sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(ensure(join(config.cacheRoot, "state")), `${safe}.log`);
}

/** Replay the append-only event log into the current session state. */
export function readState(config, sessionId) {
  const state = { reads: {}, turns: 0 };
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
      state.reads[ev.read.path] = {
        at: ev.read.at,
        tokens: ev.read.tokens,
        cachedAt: ev.read.cachedAt ?? null,
      };
    }
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
