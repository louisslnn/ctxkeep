import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.js";
import { pruneLines } from "../src/prune/lines.js";

// After eliding the middle of a Read result, a model reasoning about line
// positions must still be able to map a surviving line back to its source line
// number. The elision marker therefore states the original 1-based line range
// it replaced, so the head (lines 1..headLines) and the tail's starting line
// number are unambiguous.

test("a single elision marker states its original source line range", () => {
  const lines = Array.from({ length: 900 }, (_, i) => `content ${i + 1}`);
  const out = pruneLines(lines.join("\n"), { maxLines: 400, headLines: 100, tailLines: 40 });

  // head = lines 1..100, tail = lines 861..900, so lines 101..860 are elided.
  assert.match(out.text, /… 760 lines elided … \(original lines 101-860\)/);
  // and the tail's first surviving line is genuinely source line 861.
  assert.ok(out.text.includes("content 861"), "tail must start at the real source line");
});

test("each gap reports its own original range when error lines are salvaged", () => {
  // Bash rule: maxLines 120, head 30, tail 60. A salvaged error line mid-output
  // splits the elision into two gaps, each of which must report its own range.
  const lines = Array.from({ length: 500 }, (_, i) =>
    i === 250 ? "AssertionError: boom" : `ok ${i + 1}`,
  );
  const out = pruneLines(lines.join("\n"), DEFAULTS.prune.Bash);

  assert.ok(out.text.includes("AssertionError"), "the salvaged error must survive");
  // gap 1: lines 31..250 ; gap 2: lines 252..440
  assert.match(out.text, /\(original lines 31-250\)/);
  assert.match(out.text, /\(original lines 252-440\)/);
});

test("a one-line gap is reported in the singular with its line number", () => {
  // 102 lines, keep head 100 + tail 1, budget no salvage: exactly line 101 elided.
  const lines = Array.from({ length: 102 }, (_, i) => `x ${i + 1}`);
  const out = pruneLines(lines.join("\n"), { maxLines: 50, headLines: 100, tailLines: 1 });
  assert.match(out.text, /… 1 line elided … \(original line 101\)/);
});
