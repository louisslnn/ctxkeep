#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { readMetrics } from "../src/store.js";
import { initMemory, memoryPath, packDigest } from "../src/memory.js";
import { formatTokens } from "../src/tokenize.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [, , command = "help", ...args] = process.argv;

const config = loadConfig(process.cwd());

function init() {
  const settingsPath = join(config.projectRoot, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });

  const hooks = JSON.parse(readFileSync(join(PKG_ROOT, "hooks", "hooks.json"), "utf8")).hooks;

  // In a standalone install the plugin root placeholder doesn't apply, so
  // point the handlers at the installed package instead.
  const resolved = JSON.parse(
    JSON.stringify(hooks).replaceAll("${CLAUDE_PLUGIN_ROOT}", PKG_ROOT),
  );

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.error(`Refusing to overwrite malformed ${settingsPath}. Fix it first.`);
      process.exit(1);
    }
  }

  settings.hooks = { ...(settings.hooks || {}) };
  for (const [event, groups] of Object.entries(resolved)) {
    settings.hooks[event] = [...(settings.hooks[event] || []), ...groups];
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  const mem = initMemory(config);

  const gitignore = join(config.projectRoot, ".gitignore");
  const entry = `${config.cacheDir}/`;
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!current.includes(entry)) {
    appendFileSync(gitignore, `${current.endsWith("\n") || !current ? "" : "\n"}${entry}\n`);
  }

  console.log(`✓ hooks written to ${settingsPath}`);
  console.log(`${mem.created ? "✓ created" : "· kept existing"} ${mem.path}`);
  console.log(`✓ ${entry} added to .gitignore`);
  console.log(`\nCommit ${config.memory.file}. Do not commit ${config.cacheDir}/.`);
  console.log(`Restart Claude Code, then run: ctxkeep doctor`);
}

function stats() {
  const metrics = readMetrics(config);
  if (!metrics.length) {
    console.log("No activity recorded yet. Run a session first.");
    return;
  }

  const prunes = metrics.filter((m) => m.kind === "prune");
  const dedupes = metrics.filter((m) => m.kind === "dedupe");
  const compacts = metrics.filter((m) => m.kind === "compact");
  const refetches = metrics.filter((m) => m.kind === "refetch");

  const savedByPrune = prunes.reduce((n, m) => n + (m.saved || 0), 0);
  const savedByDedupe = dedupes.reduce((n, m) => n + (m.saved || 0), 0);
  const before = prunes.reduce((n, m) => n + (m.before || 0), 0);

  // Fidelity cost: when the model re-reads a pruned artifact it pulls the full
  // text back in, spending the tokens the prune saved (and then some). Net
  // saving is the gross prune saving minus everything re-fetched. Count a prune
  // as "re-expanded" only when a refetch's `of` matches its id, so repeat reads
  // of the same artifact don't inflate the rate beyond the prunes that exist.
  const refetchTokens = refetches.reduce((n, m) => n + (m.tokens || 0), 0);
  const prunedIds = new Set(prunes.map((m) => m.id).filter(Boolean));
  const reExpanded = new Set(
    refetches.map((m) => m.of).filter((id) => prunedIds.has(id)),
  ).size;
  const netPrune = savedByPrune - refetchTokens;

  console.log(`ctxkeep — ${new Set(metrics.map((m) => m.session)).size} session(s)\n`);
  console.log(`  pruned      ${prunes.length} results, saved ~${formatTokens(savedByPrune)} tokens`);
  if (before) {
    console.log(`              (${Math.round((savedByPrune / before) * 100)}% of pruned artifacts)`);
  }
  console.log(`  re-fetched  ${refetches.length} expansions, cost ~${formatTokens(refetchTokens)} tokens`);
  if (prunedIds.size) {
    console.log(`              (${reExpanded}/${prunedIds.size} prunes re-expanded, ` +
      `${Math.round((100 * reExpanded) / prunedIds.size)}%)`);
  }
  console.log(`  deduped     ${dedupes.length} reads, saved ~${formatTokens(savedByDedupe)} tokens`);
  console.log(`  compactions ${compacts.length} snapshotted`);
  console.log(`\n  net prune   ~${formatTokens(netPrune)} tokens (gross saved − re-fetched)`);
  console.log(`  total       ~${formatTokens(netPrune + savedByDedupe)} tokens`);

  const byTool = {};
  for (const m of prunes) byTool[m.tool] = (byTool[m.tool] || 0) + (m.saved || 0);
  const ranked = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    console.log(`\n  by tool:`);
    for (const [tool, saved] of ranked.slice(0, 6)) {
      console.log(`    ${tool.padEnd(24)} ~${formatTokens(saved)}`);
    }
  }

  console.log(`\nToken counts are heuristic estimates, not tokenizer output.`);
}

function doctor() {
  let ok = true;
  const check = (pass, label, hint) => {
    console.log(`${pass ? "✓" : "✗"} ${label}`);
    if (!pass) {
      ok = false;
      if (hint) console.log(`    ${hint}`);
    }
  };

  const settingsPath = join(config.projectRoot, ".claude", "settings.json");
  let wired = false;
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      wired = JSON.stringify(s.hooks || {}).includes("post-tool-use.js");
    } catch {
      /* reported below */
    }
  }
  check(wired, "hooks registered", "run `ctxkeep init`, or enable the plugin");
  check(existsSync(memoryPath(config)), `${config.memory.file} exists`, "run `ctxkeep init`");

  const pack = packDigest(config);
  check(
    pack !== null,
    `${config.memory.file} has content to inject`,
    "it is still the empty template — nothing will be injected until you add entries",
  );
  if (pack) {
    console.log(
      `    injecting ${pack.injectedChars} chars across ${pack.keptSections} section(s) (hard cap 10,000)`,
    );
    if (pack.droppedSections > 0) {
      check(
        false,
        `${config.memory.file} fits within the injection budget`,
        `${pack.droppedSections} whole section(s) are over the ${pack.cap}-char budget and are not ` +
          `being injected — trim ${config.memory.file} or raise memory.maxInjectedChars`,
      );
    } else if (pack.injectedChars >= pack.cap * 0.8) {
      console.log(
        `    ⚠ approaching the injection budget (${pack.injectedChars}/${pack.cap} chars); ` +
          `consider trimming ${config.memory.file} before sections start dropping`,
      );
    }
  }

  const gitignore = join(config.projectRoot, ".gitignore");
  const ignored =
    existsSync(gitignore) && readFileSync(gitignore, "utf8").includes(config.cacheDir);
  check(ignored, `${config.cacheDir}/ is gitignored`, `add ${config.cacheDir}/ to .gitignore`);

  check(readMetrics(config).length > 0, "hooks have fired at least once",
    "run a session with a large file read, then check again");

  console.log(
    ok
      ? "\nAll good."
      : "\nSome checks failed. Set CTXKEEP_DEBUG=1 to see hook errors in the transcript.",
  );
  process.exit(ok ? 0 : 1);
}

function expand() {
  const id = args[0];
  if (!id) {
    console.error("usage: ctxkeep expand <tool_use_id>");
    process.exit(1);
  }
  const path = join(config.cacheRoot, "cache", `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`);
  if (!existsSync(path)) {
    console.error(`No cached artifact for ${id}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(path, "utf8"));
}

const commands = { init, stats, doctor, expand };

if (command === "help" || !commands[command]) {
  console.log(`ctxkeep — context management for Claude Code

  ctxkeep init             wire hooks into .claude/settings.json, create CONTEXT.md
  ctxkeep doctor           verify the install and report what will be injected
  ctxkeep stats            token savings ledger
  ctxkeep expand <id>      print a cached artifact in full
`);
  process.exit(command === "help" ? 0 : 1);
}

commands[command]();
