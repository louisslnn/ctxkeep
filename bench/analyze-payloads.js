#!/usr/bin/env node
/**
 * analyze-payloads.js — tool-result size distribution from real transcripts.
 *
 * Walks Claude Code session transcripts (~/.claude/projects/<dir>/*.jsonl),
 * extracts every tool_result, attributes it to the tool that produced it, and
 * reports the size distribution plus how much each candidate prune threshold
 * would remove. It reuses the real pruner (src/prune/lines.js) so the "would be
 * pruned" and "bytes removed" figures match what the hook would actually do.
 *
 * No model calls, no quota: pure transcript analysis. This is a far larger
 * sample than the handful of calibration runs.
 *
 * Usage: node bench/analyze-payloads.js [dir ...]
 *   Defaults to the four-calibration dirs plus this repo's dev sessions.
 *
 * Already-pruned results (from a hooks-on session) carry a `[ctxkeep] Full
 * result (N lines)` pointer; we recover N so their original size still counts
 * toward the distribution and prune-counts. Their original *bytes* are gone, so
 * they are excluded from byte-fraction math (noted in the output).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pruneLines } from "../src/prune/lines.js";
import { DEFAULTS } from "../src/config.js";

const PROJECTS = join(homedir(), ".claude", "projects");
const DEFAULT_DIRS = [
  "-Users-louissalanon-bench-fixture",
  "-Users-louissalanon-bench-candidates-prettier",
  "-Users-louissalanon-Desktop-HyperCompressor",
].map((d) => join(PROJECTS, d));

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_DIRS;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  return "";
}

// Recover original line count from an already-pruned result's pointer.
const POINTER = /\[ctxkeep\][\s\S]*?Full result \((\d+) lines\)/;

// Collect { tool, lines, bytes, text|null(recovered) } for every tool_result.
const records = [];
let files = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    files++;
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    const idToName = new Map();
    // pass 1: tool_use id -> name
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const it of content)
        if (it?.type === "tool_use" && it.id) idToName.set(it.id, it.name);
    }
    // pass 2: tool_result -> record
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const it of content) {
        if (it?.type !== "tool_result") continue;
        const tool = idToName.get(it.tool_use_id) || "(unknown)";
        const t = textOf(it.content);
        if (!t) continue;
        const m = t.match(POINTER);
        if (m) {
          records.push({ tool, lines: Number(m[1]), bytes: t.length, text: null, recovered: true });
        } else {
          records.push({ tool, lines: t.split("\n").length, bytes: t.length, text: t, recovered: false });
        }
      }
    }
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

// group by tool
const byTool = new Map();
for (const r of records) {
  if (!byTool.has(r.tool)) byTool.set(r.tool, []);
  byTool.get(r.tool).push(r);
}

const totalBytes = records.filter((r) => !r.recovered).reduce((s, r) => s + r.bytes, 0);
const totalResults = records.length;
const recoveredCount = records.filter((r) => r.recovered).length;

console.log(`\nPayload distribution — ${files} transcripts, ${totalResults} tool_results ` +
  `(${recoveredCount} already-pruned, recovered by pointer)`);
console.log(`dirs: ${dirs.map((d) => d.split("/").pop()).join(", ")}`);
console.log(`total tool-output bytes (non-recovered): ${(totalBytes / 1e6).toFixed(2)} MB\n`);

// ---- per-tool size distribution ----
console.log("Per-tool result-size distribution (LINES):");
console.log("  tool          n     p50   p75   p90   p99    max");
for (const [tool, rs] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const L = rs.map((r) => r.lines).sort((a, b) => a - b);
  console.log(`  ${tool.padEnd(12)} ${String(rs.length).padStart(4)}  ` +
    [50, 75, 90, 99].map((p) => String(pct(L, p)).padStart(5)).join(" ") +
    ` ${String(L[L.length - 1]).padStart(6)}`);
}
console.log("\nPer-tool result-size distribution (BYTES, non-recovered):");
console.log("  tool          n     p50    p75    p90     p99      max");
for (const [tool, rs0] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const rs = rs0.filter((r) => !r.recovered);
  if (!rs.length) continue;
  const B = rs.map((r) => r.bytes).sort((a, b) => a - b);
  console.log(`  ${tool.padEnd(12)} ${String(rs.length).padStart(4)}  ` +
    [50, 75, 90, 99].map((p) => String(pct(B, p)).padStart(6)).join(" ") +
    ` ${String(B[B.length - 1]).padStart(7)}`);
}

// ---- prune counts + byte fraction at candidate thresholds ----
// Simulate on non-recovered records (we have their text); count recovered via
// their recovered originalLines for the count column only.
function simulate(tool, maxLines) {
  const baseRule = DEFAULTS.prune[tool] ?? DEFAULTS.prune.default;
  const rule = { ...baseRule, maxLines };
  const rs = byTool.get(tool) || [];
  let count = 0, elided = 0;
  for (const r of rs) {
    if (r.lines <= maxLines) continue;
    count++; // it would trigger
    if (r.text != null) {
      const out = pruneLines(r.text, rule);
      if (out.pruned) elided += r.bytes - out.text.length;
    }
  }
  return { count, elided, n: rs.length };
}

function reportTool(tool, thresholds, currentIdx) {
  const rs = byTool.get(tool);
  if (!rs) return;
  console.log(`\n${tool} — ${rs.length} results.  threshold sweep:`);
  console.log("  maxLines   pruned   %ofResults   bytesRemoved   %ofAllToolBytes");
  thresholds.forEach((t, i) => {
    const s = simulate(tool, t);
    const tag = i === currentIdx ? "  <- current" : "";
    console.log(`  ${String(t).padStart(5)}    ${String(s.count).padStart(6)}   ` +
      `${((100 * s.count) / rs.length).toFixed(1).padStart(6)}%      ` +
      `${(s.elided / 1000).toFixed(1).padStart(7)}k       ` +
      `${((100 * s.elided) / totalBytes).toFixed(2).padStart(6)}%${tag}`);
  });
}

console.log("\n" + "=".repeat(66));
console.log("PRUNE SWEEP (bytesRemoved fraction is of total non-recovered tool bytes)");
console.log("=".repeat(66));
reportTool("Read", [400, 300, 200, 150], 0);
reportTool("Bash", [120, 80, 60], 0);
// context: current config for the other line tools
for (const tool of ["Grep", "Glob"]) {
  const rs = byTool.get(tool);
  if (!rs) continue;
  const cur = DEFAULTS.prune[tool].maxLines;
  const s = simulate(tool, cur);
  console.log(`\n${tool} @ current ${cur} lines: pruned ${s.count}/${rs.length}, removed ${(s.elided / 1000).toFixed(1)}k bytes`);
}

// ---- headline: current config vs a proposed lower config ----
function configTotal(readMax, bashMax) {
  let elided = 0, count = 0;
  for (const [tool, max] of [["Read", readMax], ["Bash", bashMax]]) {
    const s = simulate(tool, max);
    elided += s.elided; count += s.count;
  }
  return { elided, count };
}
const cur = configTotal(400, 120);
console.log("\n" + "=".repeat(66));
console.log("Read+Bash combined:");
console.log(`  current (Read>400, Bash>120): ${cur.count} results pruned, ` +
  `${(cur.elided / 1000).toFixed(1)}k bytes (${((100 * cur.elided) / totalBytes).toFixed(2)}% of all tool bytes)`);
for (const [rm, bm] of [[300, 80], [200, 80], [150, 60]]) {
  const p = configTotal(rm, bm);
  console.log(`  Read>${rm}, Bash>${bm}: ${p.count} results pruned, ` +
    `${(p.elided / 1000).toFixed(1)}k bytes (${((100 * p.elided) / totalBytes).toFixed(2)}% of all tool bytes)`);
}
console.log();
