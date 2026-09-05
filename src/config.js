import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULTS = {
  enabled: true,

  // Where cached artifacts, session state and metrics live.
  // Relative to the project root. Add this to .gitignore.
  cacheDir: ".ctxkeep",

  prune: {
    // File reads: keep the top and bottom, elide the middle.
    // Threshold lowered 400 → 200 (BENCH_PLAN §6b, corroborated by
    // bench/analyze-payloads over 699 real tool_results): whole-file reads
    // cluster at ~150–400 lines, so 400 sat at the top of the distribution and
    // caught almost nothing (3.6% of Reads, one freak snapshot). 200 catches
    // the real cluster (13% of Reads, ~20% of tool bytes) while staying above
    // the 140-line head+tail floor, below which a prune saves nothing. Going to
    // 150 nearly doubles the prune count for ~1.5pt more bytes — mostly tiny,
    // low-value elisions the model may then re-fetch. Watch `ctxkeep stats`
    // re-fetch rate (the fidelity cost) before lowering further.
    Read: { maxLines: 200, headLines: 100, tailLines: 40 },

    // Command output: keep head and tail, but always preserve lines that
    // look like errors — those are the reason the command was run.
    Bash: {
      maxLines: 120,
      headLines: 30,
      tailLines: 60,
      // No leading \b: it must match CamelCase names like AssertionError,
      // TypeError and ValidationException, where the boundary falls inside
      // the word. This cost a fixture on the first eval run.
      //
      // Per-ecosystem notes (see eval/fixtures/bash-*-test-failure): pytest and
      // cargo group their failure detail at the head/tail of the run, so the
      // head/tail window already captures it. `go test` interleaves failures
      // through the run, so a mid-run failure lands in the elided middle and
      // must be salvaged by pattern. The last two alternatives do that:
      //   \bFAIL\b        — go's "--- FAIL: TestName" markers (standalone FAIL;
      //                     "failed" already covers FAILED via the group above)
      //   _test\.go:\d+:  — go's failure location lines, e.g.
      //                     "calc_test.go:65: expected 90, got 100"
      keepMatching:
        "(error|fatal|failed|failing|exception|traceback|panic|warn(ing)?)\\b|^\\s*(✗|×|✘|FAIL|ERR!)|\\bFAIL\\b|_test\\.go:\\d+:",
    },

    Grep: { maxLines: 80, headLines: 60, tailLines: 20 },
    Glob: { maxLines: 100, headLines: 80, tailLines: 20 },
    WebFetch: { maxChars: 12000 },

    // Fallback for any tool without an explicit rule (including MCP tools).
    default: { maxChars: 16000 },
  },

  // Skip pruning entirely for tools matching these patterns.
  // TodoWrite/Edit/Write results are already small; pruning them is pure overhead.
  neverPrune: ["Edit", "Write", "TodoWrite", "Task", "AskUserQuestion"],

  dedupe: {
    enabled: true,
    // Identity, not call-shape: a read is a duplicate when the file is unchanged
    // (content hash) and every line it would return was already delivered this
    // session (union of prior read ranges) — so offset/limit re-reads of seen
    // lines are caught, a new region is not, and a compaction resets the record.
    strategy: "content-hash+ranges",
  },

  memory: {
    // Human-editable, git-committable. Claude writes here via the skill.
    file: "CONTEXT.md",
    // Hook output is capped at 10,000 chars by Claude Code. Stay well under.
    maxInjectedChars: 7000,
  },

  // Pruned artifacts under <cacheDir>/cache/ are swept on SessionStart once
  // they age past this window. Nothing else deletes them. 0 disables the sweep.
  cache: { retentionDays: 7 },

  metrics: { enabled: true },

  // Files that must never be pruned — chiefly the cache itself, otherwise
  // expanding a pruned artifact would just prune it again.
  passthroughPaths: ["/.ctxkeep/"],
};

function deepMerge(base, override) {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

let cached = null;

/**
 * Load config from <projectRoot>/.ctxkeep.json, merged over DEFAULTS.
 * Never throws: a malformed config degrades to defaults rather than
 * breaking every tool call in the session.
 */
export function loadConfig(projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  if (cached && cached.root === projectRoot) return cached.config;

  let config = DEFAULTS;
  const path = join(projectRoot, ".ctxkeep.json");
  if (existsSync(path)) {
    try {
      config = deepMerge(DEFAULTS, JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      process.stderr.write(`ctxkeep: ignoring malformed .ctxkeep.json (${err.message})\n`);
    }
  }

  config = { ...config, projectRoot, cacheRoot: join(projectRoot, config.cacheDir) };
  cached = { root: projectRoot, config };
  return config;
}
