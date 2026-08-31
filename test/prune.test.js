import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { pruneToolOutput } from "../src/prune/index.js";
import { pruneLines } from "../src/prune/lines.js";
import { extractText, replaceText } from "../src/io.js";

function scratchConfig(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxkeep-test-"));
  return { ...DEFAULTS, ...overrides, projectRoot: root, cacheRoot: join(root, ".ctxkeep") };
}

test("short output passes through untouched", () => {
  const config = scratchConfig();
  const text = "line one\nline two\n";
  const result = pruneToolOutput({ config, toolName: "Bash", toolUseId: "t1", text });
  assert.equal(result.pruned, false);
  assert.equal(result.text, text);
});

test("long output is pruned and gains a retrieval pointer", () => {
  const config = scratchConfig();
  const text = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
  const result = pruneToolOutput({ config, toolName: "Read", toolUseId: "t2", text });
  assert.equal(result.pruned, true);
  assert.ok(result.text.includes("[ctxkeep]"));
  assert.ok(result.newTokens < result.originalTokens);
  assert.ok(result.text.includes("line 0"), "head is kept");
  assert.ok(result.text.includes("line 899"), "tail is kept");
});

test("cache reads are never pruned, so expansion cannot loop", () => {
  const config = scratchConfig();
  const text = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
  const result = pruneToolOutput({
    config,
    toolName: "Read",
    toolUseId: "t3",
    text,
    filePath: "/repo/.ctxkeep/cache/toolu_x.txt",
  });
  assert.equal(result.pruned, false);
});

test("tools on the neverPrune list are skipped", () => {
  const config = scratchConfig();
  const text = "x".repeat(100000);
  assert.equal(
    pruneToolOutput({ config, toolName: "TodoWrite", toolUseId: "t4", text }).pruned,
    false,
  );
});

test("error lines survive even when buried mid-output", () => {
  const lines = Array.from({ length: 500 }, (_, i) =>
    i === 250 ? "  AssertionError: expected 401 to be 200" : `  ok ${i}`,
  );
  const out = pruneLines(lines.join("\n"), DEFAULTS.prune.Bash);
  assert.equal(out.pruned, true);
  assert.ok(out.text.includes("AssertionError"), "CamelCase error names must be preserved");
});

test("elision markers report how much was removed", () => {
  const out = pruneLines(
    Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n"),
    { maxLines: 100, headLines: 50, tailLines: 50 },
  );
  assert.match(out.text, /… \d+ lines elided …/);
});

test("extractText handles the shapes a tool_response can take", () => {
  assert.equal(extractText("plain"), "plain");
  assert.equal(extractText({ content: "nested" }), "nested");
  assert.equal(extractText({ stdout: "out" }), "out");
  assert.equal(extractText([{ type: "text", text: "block" }]), "block");
  assert.equal(extractText(null), null);
  assert.equal(extractText({ exitCode: 0 }), null);
});

test("replaceText preserves the original response shape", () => {
  assert.equal(replaceText("old", "new"), "new");
  assert.deepEqual(replaceText({ content: "old", meta: 1 }, "new"), { content: "new", meta: 1 });
  assert.deepEqual(replaceText([{ type: "text", text: "old" }], "new"), [
    { type: "text", text: "new" },
  ]);
});
