import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.js";
import { readState } from "../src/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POST = join(HERE, "..", "hooks", "post-tool-use.js");

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

test("20 concurrent post-tool-use processes all record their read", async () => {
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
          tool_response: `contents of file ${i}`,
        },
        config.projectRoot,
      ),
    ),
  );

  const state = readState(config, session);
  const recorded = Object.keys(state.reads).sort();
  const expected = Array.from({ length: n }, (_, i) => `/repo/file${i}.js`).sort();

  assert.equal(
    recorded.length,
    n,
    `expected all ${n} reads, got ${recorded.length}: ${recorded.join(", ")}`,
  );
  assert.deepEqual(recorded, expected);
});
