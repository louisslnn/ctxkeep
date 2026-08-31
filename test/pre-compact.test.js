import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, "..", "hooks");

/** Run a hook binary with a JSON stdin payload and return parsed stdout. */
function runHook(name, input, projectDir) {
  const res = spawnSync(process.execPath, [join(HOOKS, name)], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `${name} must exit 0 (fail open). stderr: ${res.stderr}`);
  const out = res.stdout.trim();
  return out ? JSON.parse(out) : null;
}

function scratchProject() {
  const root = mkdtempSync(join(tmpdir(), "ctxkeep-precompact-"));
  // Enable the one-shot compaction gate.
  writeFileSync(
    join(root, ".ctxkeep.json"),
    JSON.stringify({ memory: { blockCompactUntilRecorded: true } }),
    "utf8",
  );
  return root;
}

test("compaction is blocked when CONTEXT.md was not touched this session", () => {
  const root = scratchProject();
  const memPath = join(root, "CONTEXT.md");
  // A memory file that has real content but was last written *before* the
  // session began (mtime set well in the past).
  writeFileSync(memPath, "# Project context\n\n## Decisions\n\n- an old decision\n", "utf8");
  const past = Date.now() / 1000 - 3600;
  utimesSync(memPath, past, past);

  runHook("session-start.js", { session_id: "s-untouched", source: "startup" }, root);

  const out = runHook(
    "pre-compact.js",
    { session_id: "s-untouched", trigger: "auto" },
    root,
  );

  assert.ok(out, "pre-compact must emit output");
  assert.equal(out.decision, "block", "an untouched memory file must block compaction");
});

test("compaction is NOT blocked when CONTEXT.md was touched this session", () => {
  const root = scratchProject();
  const memPath = join(root, "CONTEXT.md");
  writeFileSync(memPath, "# Project context\n\n## Decisions\n\n- an old decision\n", "utf8");

  runHook("session-start.js", { session_id: "s-touched", source: "startup" }, root);

  // Simulate the model writing memory during the session: mtime after startedAt.
  const future = Date.now() / 1000 + 3600;
  utimesSync(memPath, future, future);

  const out = runHook(
    "pre-compact.js",
    { session_id: "s-touched", trigger: "auto" },
    root,
  );

  assert.equal(out, null, "a touched memory file must not block compaction");
});
