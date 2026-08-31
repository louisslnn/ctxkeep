#!/usr/bin/env node
/**
 * Eval harness.
 *
 * Measuring savings is trivial and almost meaningless on its own — you can hit
 * any compression number you like by deleting more. The number that matters is
 * what you destroy to get it.
 *
 * Each fixture declares `critical` patterns: things that MUST still be findable
 * after pruning. A pattern passes if it survives in the pruned text, or if the
 * pruned text is empty of it but the retrieval pointer is present and the cache
 * holds it (recoverable at the cost of one extra tool call).
 *
 * Report both columns. A config that saves 70% and drops 15% of critical lines
 * is worse than one that saves 45% and drops none.
 */
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.js";
import { pruneToolOutput } from "../src/prune/index.js";
import { estimateTokens, formatTokens } from "../src/tokenize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const scratch = mkdtempSync(join(tmpdir(), "ctxkeep-eval-"));
const config = { ...DEFAULTS, projectRoot: scratch, cacheRoot: join(scratch, ".ctxkeep") };

function loadFixtures() {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")));
}

function run(fixture) {
  const text = fixture.text ?? readFileSync(join(FIXTURES, fixture.textFile), "utf8");

  const result = pruneToolOutput({
    config,
    toolName: fixture.tool,
    toolUseId: `eval_${fixture.name}`,
    text,
    filePath: fixture.filePath ?? "",
  });

  const recoverable = result.pruned && result.text.includes("[ctxkeep]");

  const critical = (fixture.critical || []).map((pattern) => {
    const re = new RegExp(pattern, "m");
    const inPruned = re.test(result.text);
    return { pattern, inPruned, status: inPruned ? "kept" : recoverable ? "recoverable" : "LOST" };
  });

  const lost = critical.filter((c) => c.status === "LOST").length;
  const inline = critical.filter((c) => c.status === "kept").length;

  return {
    name: fixture.name,
    tool: fixture.tool,
    before: result.originalTokens,
    after: result.newTokens,
    savedPct: result.originalTokens
      ? Math.round(((result.originalTokens - result.newTokens) / result.originalTokens) * 100)
      : 0,
    critical: critical.length,
    inline,
    lost,
    details: critical,
  };
}

const fixtures = loadFixtures();
if (!fixtures.length) {
  console.error(`No fixtures in ${FIXTURES}. Add some real tool output first.`);
  process.exit(1);
}

const rows = fixtures.map(run);

console.log(
  `\n${"fixture".padEnd(26)}${"before".padStart(8)}${"after".padStart(8)}` +
    `${"saved".padStart(8)}${"inline".padStart(9)}${"lost".padStart(6)}`,
);
console.log("-".repeat(65));

for (const r of rows) {
  console.log(
    r.name.padEnd(26) +
      formatTokens(r.before).padStart(8) +
      formatTokens(r.after).padStart(8) +
      `${r.savedPct}%`.padStart(8) +
      `${r.inline}/${r.critical}`.padStart(9) +
      String(r.lost).padStart(6),
  );
}

const totalBefore = rows.reduce((n, r) => n + r.before, 0);
const totalAfter = rows.reduce((n, r) => n + r.after, 0);
const totalLost = rows.reduce((n, r) => n + r.lost, 0);
const totalInline = rows.reduce((n, r) => n + r.inline, 0);
const totalCritical = rows.reduce((n, r) => n + r.critical, 0);

console.log("-".repeat(65));
console.log(
  "TOTAL".padEnd(26) +
    formatTokens(totalBefore).padStart(8) +
    formatTokens(totalAfter).padStart(8) +
    `${Math.round(((totalBefore - totalAfter) / totalBefore) * 100)}%`.padStart(8) +
    `${totalInline}/${totalCritical}`.padStart(9) +
    String(totalLost).padStart(6),
);

for (const r of rows) {
  const misses = r.details.filter((d) => d.status !== "kept");
  if (misses.length) {
    console.log(`\n  ${r.name}:`);
    for (const m of misses) console.log(`    [${m.status}] ${m.pattern}`);
  }
}

console.log(
  `\n"inline" = critical patterns still visible without a follow-up read.` +
    `\n"lost" = not in the pruned text and not recoverable. Any value above 0 is a bug.\n`,
);

process.exit(totalLost > 0 ? 1 : 0);
