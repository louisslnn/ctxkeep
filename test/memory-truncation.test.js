import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { buildDigest } from "../src/memory.js";

const NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];

function section(name) {
  // A header, a padded detail line, and a terminal sentinel. If any part of a
  // section is injected, its <NAME>_END sentinel must be too — otherwise the
  // section was cut in half.
  return `## ${name}\n- ${name.toLowerCase()} detail ${"x".repeat(120)}\n- ${name.toUpperCase()}_END\n`;
}

function scratchConfig(maxInjectedChars) {
  const root = mkdtempSync(join(tmpdir(), "ctxkeep-mem-"));
  const body = "# Project context\n\nHuman-facing preamble line.\n\n" + NAMES.map(section).join("\n");
  writeFileSync(join(root, "CONTEXT.md"), body, "utf8");
  return {
    ...DEFAULTS,
    memory: { ...DEFAULTS.memory, maxInjectedChars },
    projectRoot: root,
    cacheRoot: join(root, ".ctxkeep"),
  };
}

test("an oversized CONTEXT.md is injected as whole sections, never a partial one", () => {
  const config = scratchConfig(450); // small cap forces sections to be dropped
  const digest = buildDigest(config);
  assert.ok(digest, "a non-empty memory file must produce a digest");

  // The core guarantee: every section header that appears must be complete.
  for (const name of NAMES) {
    if (digest.includes(`## ${name}`)) {
      assert.ok(
        digest.includes(`${name.toUpperCase()}_END`),
        `section ${name} was injected without its terminal line — a partial section`,
      );
    }
  }

  // And truncation genuinely happened (otherwise the assertion above is vacuous).
  const present = NAMES.filter((n) => digest.includes(`## ${n}`));
  assert.ok(present.length >= 1, "at least one whole section should fit");
  assert.ok(present.length < NAMES.length, "the small cap must have dropped some sections");

  // Never exceed Claude Code's hard hook-output cap.
  assert.ok(digest.length <= 10000, "digest must stay under the 10,000-char hook cap");
});
