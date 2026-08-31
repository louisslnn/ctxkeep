import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText } from "../src/io.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOADS = join(HERE, "fixtures", "payloads");

function load(name) {
  return JSON.parse(readFileSync(join(PAYLOADS, name), "utf8"));
}

// These fixtures are REAL PostToolUse payloads captured from a live Claude Code
// session (task 1.4), not hand-written. extractText must pull the human-readable
// text out of the exact shape each tool actually emits.

test("Read: text lives in tool_response.file.content", () => {
  const p = load("read.json");
  const text = extractText(p.tool_response);
  assert.equal(text, p.tool_response.file.content);
  assert.ok(text.includes("MIT License"), "the real file body must come through");
});

test("Bash: text lives in tool_response.stdout", () => {
  const p = load("bash.json");
  const text = extractText(p.tool_response);
  assert.equal(text, p.tool_response.stdout);
  assert.ok(text.length > 0);
});

test("WebFetch: text lives in tool_response.result", () => {
  const p = load("webfetch.json");
  const text = extractText(p.tool_response);
  assert.equal(text, p.tool_response.result);
  assert.ok(text.includes("Example Domain"));
});

test("MCP tool: text lives in an array of {type,text} blocks", () => {
  const p = load("mcp-ide-getdiagnostics.json");
  const text = extractText(p.tool_response);
  const expected = p.tool_response.map((b) => b.text).join("\n");
  assert.equal(text, expected);
  assert.ok(text.includes("diagnostics"));
});

test("every committed payload fixture yields non-empty text", () => {
  const files = readdirSync(PAYLOADS).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 4, "expected the captured fixtures to be present");
  for (const f of files) {
    const p = load(f);
    const text = extractText(p.tool_response);
    assert.equal(typeof text, "string", `${f}: extractText must return a string`);
    assert.ok(text.length > 0, `${f}: extractText must return non-empty text`);
  }
});
