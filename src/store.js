import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Everything ctxkeep persists lives under <projectRoot>/.ctxkeep/:
 *
 *   cache/<tool_use_id>.txt   full artifact, so pruning is reversible
 *   state/<session_id>.json   per-session dedupe table
 *   metrics.jsonl             append-only savings ledger
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
  return join(ensure(join(config.cacheRoot, "state")), `${safe}.json`);
}

export function readState(config, sessionId) {
  const path = statePath(config, sessionId);
  if (!existsSync(path)) return { reads: {}, turns: 0 };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { reads: {}, turns: 0 };
  }
}

export function writeState(config, sessionId, state) {
  try {
    writeFileSync(statePath(config, sessionId), JSON.stringify(state), "utf8");
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
