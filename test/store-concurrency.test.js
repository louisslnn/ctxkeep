import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.js";
import { readMetrics } from "../src/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POST = join(HERE, "..", "hooks", "post-tool-use.js");

const bigOutput = (n = 600) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

function scratchConfig() {
  const root = mkdtempSync(join(tmpdir(), "ctxkeep-race-"));
  return { ...DEFAULTS, projectRoot: root, cacheRoot: join(root, ".ctxkeep") };
}

function runPost(input, projectDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [POST], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve(code));
    child.stdin.end(JSON.stringify(input));
  });
}

// The metrics ledger is an append-only log written by PostToolUse. Claude Code
// can run tools concurrently, so many prunes race to append at once. An O_APPEND
// write is atomic for small records, so no entry should clobber another — this
// asserts that property directly against the real prune path.
test("20 concurrent post-tool-use prunes all record their metric", async () => {
  const config = scratchConfig();
  const session = "race-session";
  const n = 20;

  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runPost(
        {
          session_id: session,
          tool_name: "Read",
          tool_use_id: `t${i}`,
          tool_input: { file_path: `/repo/file${i}.js` },
          tool_response: { type: "text", file: { filePath: `/repo/file${i}.js`, content: bigOutput() } },
        },
        config.projectRoot,
      ),
    ),
  );

  const prunes = readMetrics(config).filter((m) => m.kind === "prune");
  const ids = prunes.map((m) => m.id).sort();
  const expected = Array.from({ length: n }, (_, i) => `t${i}`).sort();

  assert.equal(prunes.length, n, `expected all ${n} prune metrics, got ${prunes.length}: ${ids.join(", ")}`);
  assert.deepEqual(ids, expected);
});
