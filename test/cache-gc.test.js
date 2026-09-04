import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_START = join(HERE, "..", "hooks", "session-start.js");
const DAY = 24 * 60 * 60 * 1000;

function scratch(retentionDays) {
  const root = mkdtempSync(join(tmpdir(), "ctxkeep-gc-"));
  writeFileSync(join(root, ".ctxkeep.json"), JSON.stringify({ cache: { retentionDays } }), "utf8");
  const cacheDir = join(root, ".ctxkeep", "cache");
  mkdirSync(cacheDir, { recursive: true });
  return { root, cacheDir };
}

function writeAged(path, ageMs) {
  writeFileSync(path, "cached artifact\n", "utf8");
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

test("session start sweeps cache files older than the retention window", () => {
  const { root, cacheDir } = scratch(7);
  const stale = join(cacheDir, "toolu_old.txt");
  const fresh = join(cacheDir, "toolu_new.txt");
  writeAged(stale, 30 * DAY);
  writeAged(fresh, 1 * DAY);

  const res = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: "gc-1", source: "startup" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `session-start must exit 0. stderr: ${res.stderr}`);

  assert.equal(existsSync(stale), false, "a file older than retention must be removed");
  assert.equal(existsSync(fresh), true, "a file within retention must be kept");
});

test("session start does NOT sweep the cache on resume", () => {
  // A resumed conversation still contains pruned tool results whose [ctxkeep]
  // pointers reference these cache files. Sweeping an aged one here — on the very
  // resume that brings it back into context — makes the elided middle
  // unrecoverable, breaking the reversibility invariant. Only a fresh `startup`,
  // which has no prior pruned results in context, may sweep.
  const { root, cacheDir } = scratch(7);
  const stale = join(cacheDir, "toolu_resumed.txt");
  writeAged(stale, 30 * DAY);

  const res = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: "gc-resume", source: "resume" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `session-start must exit 0. stderr: ${res.stderr}`);
  assert.equal(
    existsSync(stale),
    true,
    "resume must not delete an artifact the resumed session may still point at",
  );
});

test("sweepCache honours the retention boundary and is disabled at 0", async () => {
  const { sweepCache } = await import("../src/store.js");
  const { root, cacheDir } = scratch(0);
  const config = { ...DEFAULTS, cache: { retentionDays: 0 }, projectRoot: root, cacheRoot: join(root, ".ctxkeep") };

  const old1 = join(cacheDir, "a.txt");
  writeAged(old1, 30 * DAY);
  assert.equal(sweepCache(config), 0, "retentionDays 0 disables the sweep");
  assert.equal(existsSync(old1), true);

  config.cache.retentionDays = 7;
  const young = join(cacheDir, "b.txt");
  writeAged(young, 2 * DAY);
  const removed = sweepCache(config);
  assert.equal(removed, 1, "only the file past the window is removed");
  assert.equal(existsSync(old1), false);
  assert.equal(existsSync(young), true);
});
