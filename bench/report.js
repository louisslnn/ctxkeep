#!/usr/bin/env node
/**
 * Turns benchmark trials into a number you can defend.
 *
 * Reports the median rather than the mean: agent-run cost distributions have a
 * long right tail (one run wanders, burns 30 turns, and drags the mean with
 * it), and the median is what a typical session actually costs.
 *
 * The confidence interval is a bootstrap over the median difference. If it
 * straddles zero, you do not have a result — you have noise, and the honest
 * move is more trials or a bigger task, not a headline.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node bench/report.js <results.jsonl>");
  process.exit(1);
}

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const arms = [...new Set(rows.map((r) => r.arm))];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Bootstrap CI for the difference in medians between two samples. */
function bootstrapDiff(a, b, iterations = 5000) {
  if (a.length < 3 || b.length < 3) return null;
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    const ra = Array.from({ length: a.length }, () => a[(Math.random() * a.length) | 0]);
    const rb = Array.from({ length: b.length }, () => b[(Math.random() * b.length) | 0]);
    diffs.push(median(rb) - median(ra));
  }
  diffs.sort((x, y) => x - y);
  return {
    lo: diffs[Math.floor(0.025 * diffs.length)],
    hi: diffs[Math.floor(0.975 * diffs.length)],
  };
}

const byArm = {};
for (const arm of arms) {
  const all = rows.filter((r) => r.arm === arm);
  const ok = all.filter((r) => r.passed && r.costUsd != null);
  byArm[arm] = {
    total: all.length,
    passed: ok.length,
    errors: all.filter((r) => r.error).length,
    successRate: all.length ? ok.length / all.length : 0,
    // Cost is computed over SUCCESSFUL runs only. A cheap run that failed the
    // task is not a saving, it is a different (worse) outcome.
    cost: ok.map((r) => r.costUsd),
    turns: ok.map((r) => r.numTurns).filter((n) => n != null),
    inputTokens: ok.map((r) => r.inputTokens ?? 0),
    cacheRead: ok.map((r) => r.cacheReadTokens ?? 0),
    claimed: ok.map((r) => r.ledger?.claimedSaved ?? 0),
  };
}

const baseline = arms.includes("off") ? "off" : arms[0];

console.log(`\nTask: ${rows[0].task}   trials/arm: ${byArm[baseline].total}\n`);
console.log(
  "arm".padEnd(8) +
    "pass".padStart(8) +
    "cost p50".padStart(11) +
    "cost p25–p75".padStart(17) +
    "turns p50".padStart(11) +
    "cache%".padStart(9),
);
console.log("-".repeat(64));

for (const arm of arms) {
  const s = byArm[arm];
  const cacheTotal = s.cacheRead.reduce((n, x) => n + x, 0);
  const inTotal = s.inputTokens.reduce((n, x) => n + x, 0) + cacheTotal;
  console.log(
    arm.padEnd(8) +
      `${s.passed}/${s.total}`.padStart(8) +
      (median(s.cost) != null ? `$${median(s.cost).toFixed(4)}` : "—").padStart(11) +
      (s.cost.length
        ? `$${quantile(s.cost, 0.25).toFixed(4)}–$${quantile(s.cost, 0.75).toFixed(4)}`
        : "—"
      ).padStart(17) +
      String(median(s.turns) ?? "—").padStart(11) +
      (inTotal ? `${Math.round((cacheTotal / inTotal) * 100)}%` : "—").padStart(9),
  );
}

console.log("\nvs baseline (" + baseline + "):");
for (const arm of arms.filter((a) => a !== baseline)) {
  const base = byArm[baseline].cost;
  const arm_ = byArm[arm].cost;
  const ci = bootstrapDiff(base, arm_);
  const mb = median(base);
  const ma = median(arm_);

  if (!ci || mb == null || ma == null) {
    console.log(`  ${arm.padEnd(8)} not enough successful runs to compare`);
    continue;
  }

  const pct = ((mb - ma) / mb) * 100;
  const loPct = (-ci.hi / mb) * 100;
  const hiPct = (-ci.lo / mb) * 100;
  const crossesZero = ci.lo < 0 && ci.hi > 0;

  console.log(
    `  ${arm.padEnd(8)} saves ${pct.toFixed(1)}% ` +
      `(95% CI: ${loPct.toFixed(1)}% to ${hiPct.toFixed(1)}%)` +
      (crossesZero ? "" : "  ✓"),
  );
  if (crossesZero) {
    console.log(
      `  ${" ".repeat(8)} ⚠ the interval includes zero — a negative bound means this arm ` +
        `may cost MORE.\n${" ".repeat(11)}Not a result yet. Add trials, or use a task with more headroom.`,
    );
  }

  const dropped = byArm[baseline].successRate - byArm[arm].successRate;
  if (dropped > 0.001) {
    console.log(
      `  ${" ".repeat(8)} ⚠ success rate fell ${(dropped * 100).toFixed(0)} points ` +
        `(${(byArm[baseline].successRate * 100).toFixed(0)}% → ${(byArm[arm].successRate * 100).toFixed(0)}%). ` +
        `Cost savings bought with correctness are not savings.`,
    );
  }
}

// Self-reported vs measured. ctxkeep's own ledger counts tokens it removed
// from tool results; the benchmark counts what the API actually billed. They
// should be in the same neighbourhood. A large gap means the ledger is
// measuring something other than what you are paying for — most often because
// pruning shifted cache hit rates, or because the model spent extra turns
// re-fetching what was pruned away.
console.log("\nself-reported vs measured:");
for (const arm of arms.filter((a) => a !== baseline)) {
  const claimed = median(byArm[arm].claimed);
  const baseIn = median(byArm[baseline].inputTokens);
  const armIn = median(byArm[arm].inputTokens);
  if (claimed == null || baseIn == null || armIn == null) continue;
  const measured = baseIn - armIn;
  const ratio = claimed > 0 ? measured / claimed : null;
  console.log(
    `  ${arm.padEnd(8)} ledger claims ~${Math.round(claimed)} tokens saved; ` +
      `measured uncached-input delta ${Math.round(measured)} tokens` +
      (ratio != null ? `  (${(ratio * 100).toFixed(0)}% of claim)` : ""),
  );
  if (ratio != null && (ratio < 0.5 || ratio > 1.5)) {
    console.log(
      `  ${" ".repeat(8)} ⚠ ledger and billing disagree by more than 2x. Usual causes: pruning\n` +
        `${" ".repeat(11)}shifted cache hit rates, or the model spent extra turns re-fetching\n` +
        `${" ".repeat(11)}what was pruned. Trust the billing number.`,
    );
  }
}

console.log(
  `\nCost is measured over successful runs only. Medians, not means: the cost\n` +
    `distribution has a long right tail and one wandering run distorts a mean.\n`,
);
