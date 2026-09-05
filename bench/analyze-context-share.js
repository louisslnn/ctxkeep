#!/usr/bin/env node
/**
 * analyze-context-share.js — tests two claims against real transcripts.
 *
 * Q1 (ARCHITECTURE.md §1): "in an agentic coding session tool results dominate
 * the context window." We measure tool-output tokens against the context the
 * model actually ingested, per session, using the usage block each assistant
 * message carries (input / cache_creation / cache_read).
 *
 * Q3 (net saving per prune): at the new Read>200 rule, what does each prune
 * actually save once the fixed ~40-word pointer is subtracted, and would a
 * minimum-net-saving floor (skip the prune when the projected saving is tiny)
 * beat the current pure line-count rule?
 *
 * Pure transcript analysis. No model calls, no quota. Reuses the real pruner
 * and the real token estimator so figures match what the hook would do.
 *
 * Usage: node bench/analyze-context-share.js [dir ...]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pruneLines } from "../src/prune/lines.js";
import { estimateTokens } from "../src/tokenize.js";
import { DEFAULTS } from "../src/config.js";

const PROJECTS = join(homedir(), ".claude", "projects");
const DEFAULT_DIRS = [
  "-Users-louissalanon-bench-fixture",
  "-Users-louissalanon-bench-candidates-prettier",
  "-Users-louissalanon-Desktop-HyperCompressor",
].map((d) => join(PROJECTS, d));

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DIRS;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  return "";
}

const POINTER = /\[ctxkeep\][\s\S]*?Full result \((\d+) lines\)/;

// The exact pointer the pruner appends (index.js), for its token cost.
const SAMPLE_POINTER =
  `\n\n---\n[ctxkeep] This output was shortened to save context. ` +
  `Full result (1446 lines) is at: .ctxkeep/cache/toolu_01HXE3pVx7XoZTUxotN8JDQf.txt\n` +
  `Read that path if the elided section matters. It is exempt from pruning.`;
const POINTER_TOKENS = estimateTokens(SAMPLE_POINTER);

// --- gather per-session usage + tool-output, and every Read record's text ---
const sessions = new Map(); // sessionId -> aggregates
const readRecords = []; // { lines, text } for non-pruned Read results
let anyPrunedSeen = 0;

function sess(id) {
  if (!sessions.has(id))
    sessions.set(id, {
      toolOutTokens: 0,
      toolResults: 0,
      prunedResults: 0,
      ingested: 0, // Σ (input + cache_creation) = distinct tokens the model ingested
      billed: 0, // Σ (input + cache_creation + cache_read) = billed input
      peakWindow: 0, // max single-message prefix size
      turns: 0,
      hooksOn: false,
    });
  return sessions.get(id);
}

for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    const idToName = new Map();
    const seenMsg = new Set();
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const content = o?.message?.content;
      if (Array.isArray(content))
        for (const it of content)
          if (it?.type === "tool_use" && it.id) idToName.set(it.id, it.name);
    }
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const sid = o?.sessionId || f;
      const s = sess(sid);
      const msg = o?.message;
      // assistant usage
      const u = msg?.usage;
      if (u && o?.uuid && !seenMsg.has(o.uuid)) {
        seenMsg.add(o.uuid);
        const inp = u.input_tokens || 0;
        const cc = u.cache_creation_input_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        s.ingested += inp + cc;
        s.billed += inp + cc + cr;
        s.peakWindow = Math.max(s.peakWindow, inp + cc + cr);
        s.turns++;
      }
      // tool results
      const content = msg?.content;
      if (Array.isArray(content))
        for (const it of content) {
          if (it?.type !== "tool_result") continue;
          const t = textOf(it.content);
          if (!t) continue;
          s.toolResults++;
          const m = t.match(POINTER);
          if (m) {
            s.prunedResults++;
            s.hooksOn = true;
            anyPrunedSeen++;
            // pruned: present text is head+tail+pointer; original tokens are gone.
            // Count present tokens (undercount) — flagged in output.
            s.toolOutTokens += estimateTokens(t);
          } else {
            s.toolOutTokens += estimateTokens(t);
            const tool = idToName.get(it.tool_use_id);
            if (tool === "Read")
              readRecords.push({ lines: t.split("\n").length, text: t });
          }
        }
    }
  }
}

// ---- Q1 report ----
console.log("\n" + "=".repeat(74));
console.log("Q1 — Does tool output dominate the context window? (per session)");
console.log("=".repeat(74));
console.log(
  "  session          turns  toolRes  toolOut   ingested   %ingest  peakWin  %peak  hooks",
);
const ordered = [...sessions.entries()]
  .filter(([, s]) => s.turns > 0 && s.toolResults > 0)
  .sort((a, b) => b[1].ingested - a[1].ingested);
let T = { toolOut: 0, ingested: 0, billed: 0 };
for (const [sid, s] of ordered) {
  T.toolOut += s.toolOutTokens; T.ingested += s.ingested; T.billed += s.billed;
  const pIng = s.ingested ? (100 * s.toolOutTokens) / s.ingested : 0;
  const pPeak = s.peakWindow ? (100 * s.toolOutTokens) / s.peakWindow : 0;
  console.log(
    `  ${sid.slice(0, 8).padEnd(9)} ${String(s.turns).padStart(9)} ` +
    `${String(s.toolResults).padStart(7)} ${String(Math.round(s.toolOutTokens / 100) / 10 + "k").padStart(8)} ` +
    `${String(Math.round(s.ingested / 100) / 10 + "k").padStart(9)} ${(pIng.toFixed(0) + "%").padStart(8)} ` +
    `${String(Math.round(s.peakWindow / 100) / 10 + "k").padStart(7)} ${(pPeak.toFixed(0) + "%").padStart(6)}  ` +
    `${s.hooksOn ? "ON(" + s.prunedResults + ")" : "off"}`,
  );
}
console.log("  " + "-".repeat(72));
console.log(
  `  Aggregate: toolOut ${(T.toolOut / 1000).toFixed(0)}k tok, ingested-context ` +
  `${(T.ingested / 1000).toFixed(0)}k tok → tool output = ` +
  `${((100 * T.toolOut) / T.ingested).toFixed(1)}% of distinct context ingested.`,
);
console.log(
  `  For scale, billed input incl. cache re-reads was ${(T.billed / 1e6).toFixed(2)}M tok ` +
  `(${((100 * T.toolOut) / T.billed).toFixed(1)}% is tool output).`,
);
if (anyPrunedSeen)
  console.log(
    `  NOTE: hooks-ON sessions have ${anyPrunedSeen} already-pruned results; their\n` +
    `  ORIGINAL tool tokens are gone, so toolOut there is an UNDERCOUNT. Read the\n` +
    `  hooks-off rows (bench-fixture, prettier RUN A) as the clean natural picture.`,
  );

// ---- Q3 report ----
console.log("\n" + "=".repeat(74));
console.log("Q3 — Net saving per prune at Read>200, and would a floor beat it?");
console.log("=".repeat(74));
console.log(`  fixed pointer cost: ${POINTER_TOKENS} tokens (added to every prune)`);
const rule = { ...DEFAULTS.prune.Read }; // maxLines 200 now
const perPrune = [];
for (const r of readRecords) {
  if (r.lines <= rule.maxLines) continue;
  const out = pruneLines(r.text, rule);
  if (!out.pruned) continue;
  const before = estimateTokens(r.text);
  const after = estimateTokens(out.text) + POINTER_TOKENS;
  perPrune.push({ lines: r.lines, before, after, saved: before - after });
}
perPrune.sort((a, b) => a.saved - b.saved);
const savedArr = perPrune.map((p) => p.saved);
const q = (p) => savedArr.length ? savedArr[Math.min(savedArr.length - 1, Math.floor((p / 100) * savedArr.length))] : 0;
const sum = (a) => a.reduce((n, x) => n + x, 0);
console.log(
  `  ${perPrune.length} Reads pruned. net saved/prune (tokens): ` +
  `min ${q(0)}  p25 ${q(25)}  median ${q(50)}  p90 ${q(90)}  max ${savedArr[savedArr.length - 1] ?? 0}`,
);
console.log(`  total net saved across all prunes: ${(sum(savedArr) / 1000).toFixed(1)}k tokens`);
console.log(`  prunes netting <=0 tokens: ${perPrune.filter((p) => p.saved <= 0).length}`);
console.log("\n  Floor sweep — skip the prune when projected net saving < F:");
console.log("    F(tok)   prunes kept   prunes skipped   savings kept   savings forgone");
for (const F of [0, 100, 200, 400, 800]) {
  const kept = perPrune.filter((p) => p.saved >= F);
  const skipped = perPrune.filter((p) => p.saved < F);
  console.log(
    `    ${String(F).padStart(5)}    ${String(kept.length).padStart(9)}   ` +
    `${String(skipped.length).padStart(12)}    ${((sum(kept.map((p) => p.saved)) / 1000).toFixed(1) + "k").padStart(10)}      ` +
    `${((sum(skipped.map((p) => p.saved)) / 1000).toFixed(1) + "k").padStart(10)}`,
  );
}
console.log();
