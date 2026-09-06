#!/usr/bin/env node
/**
 * ctxkeep benchmark runner.
 *
 * Measures end-to-end cost of a real Claude Code task with ctxkeep on vs off.
 *
 * Three design choices that matter more than the code:
 *
 * 1. REPEATED TRIALS. Agent runs are wildly nondeterministic — the same task
 *    can take 8 turns or 22 depending on which file it opens first. A single
 *    A/B pair tells you nothing. Default is 8 trials per arm.
 *
 * 2. INTERLEAVED ARMS. Runs go A,B,C,A,B,C… not AAA,BBB,CCC. Prompt cache
 *    state, API load and model routing all drift over the span of an hour;
 *    blocking by arm bakes that drift into the result.
 *
 * 3. A CORRECTNESS GATE. Every run is scored pass/fail by a real command.
 *    Savings measured over runs that failed the task are not savings.
 *
 * Usage:
 *   node bench/run.js --task bench/tasks/example.json --trials 8
 *   node bench/report.js bench/results/<run-id>.jsonl
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const taskPath = args.task;
if (!taskPath) {
  console.error("usage: node bench/run.js --task <task.json> [--trials 8] [--arms off,prune,full]");
  process.exit(1);
}

const task = JSON.parse(readFileSync(taskPath, "utf8"));
const trials = Number(args.trials ?? 8);
const armNames = String(args.arms ?? "off,on").split(",");

/**
 * Pin the model. If routing shifts between the `off` runs and the `prune` runs,
 * you are measuring the model change, not the tool. This is the single most
 * common way a benchmark like this silently becomes meaningless.
 */
const model = args.model ?? task.model;
if (!model) {
  console.error(
    "Refusing to run without an explicit model.\n" +
      "  Pass --model <id> or set \"model\" in the task spec.\n" +
      "  An unpinned model can change mid-matrix and invalidate every comparison.",
  );
  process.exit(1);
}

/**
 * Arms differ only in .ctxkeep.json. Pruning is the only lever now (dedupe was
 * removed — see ARCHITECTURE.md §12), so this is a straight on/off comparison.
 */
const ARMS = {
  off: { enabled: false },
  on: { enabled: true },
};

const runId = `${task.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = resolve("bench/results");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${runId}.jsonl`);

const repo = resolve(task.repo);
if (!existsSync(repo)) {
  console.error(`Repo not found: ${repo}`);
  process.exit(1);
}

function sh(cmd, cwd, opts = {}) {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: "pipe", ...opts });
}

/** Reset the repo to a known commit so every trial starts identically. */
function resetRepo() {
  sh(`git checkout -- . && git clean -fdx -e node_modules`, repo);
  sh(`git checkout ${task.commit}`, repo);
  rmSync(join(repo, ".ctxkeep"), { recursive: true, force: true });
}

function writeArmConfig(arm) {
  writeFileSync(join(repo, ".ctxkeep.json"), JSON.stringify(ARMS[arm], null, 2));
  // Hide the benchmark's own artifacts from `git status`. If the agent sees a
  // stray untracked .ctxkeep.json it may investigate it, which is a turn spent
  // on the harness rather than the task — and it differs between arms.
  const exclude = join(repo, ".git", "info", "exclude");
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.includes(".ctxkeep")) {
      appendFileSync(exclude, "\n.ctxkeep/\n.ctxkeep.json\n");
    }
  } catch {
    /* best effort */
  }
}

/** Programmatic pass/fail. Non-zero exit = the agent did not do the job. */
function verify() {
  try {
    sh(task.verify, repo, { timeout: (task.verifyTimeoutSec ?? 300) * 1000 });
    return true;
  } catch {
    return false;
  }
}

function readCtxkeepLedger() {
  const empty = {
    prunes: 0, refetches: 0, compacts: 0,
    savedByPrune: 0, refetchTokens: 0, netPrune: 0,
  };
  const path = join(repo, ".ctxkeep", "metrics.jsonl");
  if (!existsSync(path)) return empty;
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const prunes = rows.filter((r) => r.kind === "prune");
  const refetches = rows.filter((r) => r.kind === "refetch");
  const compacts = rows.filter((r) => r.kind === "compact");

  const savedByPrune = prunes.reduce((n, r) => n + (r.saved || 0), 0);
  const refetchTokens = refetches.reduce((n, r) => n + (r.tokens || 0), 0);
  const netPrune = savedByPrune - refetchTokens;

  return {
    prunes: prunes.length,
    refetches: refetches.length,
    compacts: compacts.length,
    savedByPrune,
    refetchTokens,
    netPrune,
  };
}

function runTrial(arm, trial) {
  resetRepo();
  writeArmConfig(arm);

  const started = Date.now();
  let raw;
  try {
    raw = execFileSync(
      "claude",
      [
        "-p",
        task.prompt,
        "--output-format",
        "json",
        "--max-turns",
        String(task.maxTurns ?? 40),
        "--model",
        model,
        "--dangerously-skip-permissions",
      ],
      {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: (task.timeoutSec ?? 900) * 1000,
      },
    );
  } catch (err) {
    return {
      arm,
      trial,
      error: err.message.slice(0, 300),
      passed: false,
      wallMs: Date.now() - started,
    };
  }

  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    return { arm, trial, error: "unparseable claude output", passed: false };
  }

  const u = out.usage || {};
  const passed = verify();

  return {
    arm,
    trial,
    passed,
    costUsd: out.total_cost_usd ?? null,
    numTurns: out.num_turns ?? null,
    durationMs: out.duration_ms ?? null,
    wallMs: Date.now() - started,
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheCreateTokens: u.cache_creation_input_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    sessionId: out.session_id ?? null,
    ledger: readCtxkeepLedger(),
  };
}

// --- preflight ---------------------------------------------------------
// Burning 24 runs of quota only to find the hooks never fired is the most
// expensive mistake available here. Check first.
console.log(`Model: ${model}`);
console.log(`Preflight: confirming hooks fire in -p mode…`);
resetRepo();
writeArmConfig("full");
try {
  // The prompt must force a single FULL-file read. A terse ask like "reply with
  // the first heading" makes the agent page the file in <200-line windows (it
  // self-limits), nothing crosses the prune threshold, and this check false-
  // aborts even though the hooks are firing. Asking it to summarise the whole
  // file is what produces a real full read — and therefore a real prune.
  execFileSync("claude", ["-p", "Read the README file in full and summarise what this project is in two sentences.",
    "--output-format", "json", "--max-turns", "3", "--model", model,
    "--dangerously-skip-permissions"],
    { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
} catch (err) {
  console.error(`Preflight run failed: ${err.message.slice(0, 200)}`);
  process.exit(1);
}
const preflight = readCtxkeepLedger();
if (preflight.prunes === 0) {
  console.error(
    `\n✗ No ctxkeep activity recorded during a -p run.\n` +
      `  The hooks are not firing headless. Check:\n` +
      `    - hooks are in ~/.claude/settings.json, not only the project (workspace trust)\n` +
      `    - you are not passing a flag that skips loading settings\n` +
      `    - CTXKEEP_DEBUG=1 shows no errors\n` +
      `  Fix this before spending quota on the full matrix.\n`,
  );
  process.exit(1);
}
console.log(`✓ hooks active (${preflight.prunes} prunes recorded)\n`);

// --- matrix ------------------------------------------------------------
const total = trials * armNames.length;
let n = 0;

for (let trial = 0; trial < trials; trial++) {
  // Interleave, and rotate the arm order so no arm always runs first.
  const order = [...armNames.slice(trial % armNames.length), ...armNames.slice(0, trial % armNames.length)];
  for (const arm of order) {
    n++;
    process.stdout.write(`[${n}/${total}] trial ${trial + 1} arm=${arm} … `);
    const result = runTrial(arm, trial);
    appendFileSync(outFile, JSON.stringify({ task: task.name, runId, ...result }) + "\n");
    console.log(
      result.error
        ? `ERROR`
        : `${result.passed ? "pass" : "FAIL"} $${result.costUsd?.toFixed(4)} ${result.numTurns}t`,
    );
  }
}

resetRepo();
console.log(`\nWrote ${outFile}`);
console.log(`Now run: node bench/report.js ${outFile}`);
