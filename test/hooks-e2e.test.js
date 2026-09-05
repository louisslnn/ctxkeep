import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end hook tests.
 *
 * The unit tests exercise src/prune/ in isolation. These drive the actual hook
 * BINARIES the way Claude Code does: spawn the process, write a realistic
 * PostToolUse/PreToolUse/SessionStart/PreCompact payload to stdin, and assert
 * the JSON it prints to stdout.
 *
 * The load-bearing half is the fail-open path (ARCHITECTURE.md §7): a hook that
 * throws, hangs, or prints garbage degrades the user's whole session. So a
 * broken hook MUST look like no hook — exit 0, print nothing. That is asserted
 * here for malformed input, a missing config file, and an unwritable cache
 * directory, against every hook.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, "..", "hooks");
const HOOK_FILES = ["pre-tool-use.js", "post-tool-use.js", "session-start.js", "pre-compact.js"];

const bigOutput = (n = 600) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

function scratch(prefix = "ctxkeep-e2e-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Spawn a hook with a raw stdin string. Returns { status, stdout, stderr }. */
function runRaw(name, rawStdin, projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, [join(HOOKS, name)], {
    input: rawStdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
    encoding: "utf8",
  });
}

/** Spawn a hook with a JSON payload; assert exit 0; return parsed stdout or null. */
function runHook(name, input, projectDir) {
  const res = runRaw(name, JSON.stringify(input), projectDir);
  assert.equal(res.status, 0, `${name} must exit 0 (fail open). stderr: ${res.stderr}`);
  const out = res.stdout.trim();
  return out ? JSON.parse(out) : null;
}

// --- PostToolUse: prune ------------------------------------------------------

test("post-tool-use prunes a large Read and appends a retrieval pointer", () => {
  const root = scratch();
  const out = runHook(
    "post-tool-use.js",
    {
      session_id: "s-read",
      tool_name: "Read",
      tool_use_id: "toolu_read1",
      tool_input: { file_path: "/repo/big.js" },
      // The real Read shape captured in task 1.4.
      tool_response: { type: "text", file: { filePath: "/repo/big.js", content: bigOutput() } },
    },
    root,
  );

  assert.ok(out, "a large Read must be pruned");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");

  // NOTE: replaceText round-trips the object shape for Bash/WebFetch/MCP, but
  // for the Read shape ({type, file:{content}}) it has no matching branch and
  // returns the pruned text as a bare STRING. Asserting the real behavior here
  // rather than assuming an object. (Flagged for review, not changed — 2.2 is
  // tests only.)
  const uo = out.hookSpecificOutput.updatedToolOutput;
  const text = typeof uo === "string" ? uo : JSON.stringify(uo);
  assert.match(text, /\[ctxkeep\]/, "pruned output must carry a retrieval pointer");
  assert.match(text, /elided/, "pruned output must mark the elision");

  // Reversibility (invariant 2): the full text must be stashed on disk.
  const cacheFiles = readdirSync(join(root, ".ctxkeep", "cache"));
  assert.ok(cacheFiles.length >= 1, "the original must be stashed to the cache");
});

test("post-tool-use prunes a large Bash result and keeps its object shape", () => {
  const root = scratch();
  const out = runHook(
    "post-tool-use.js",
    {
      session_id: "s-bash",
      tool_name: "Bash",
      tool_use_id: "toolu_bash1",
      tool_input: { command: "npm test" },
      tool_response: { stdout: bigOutput(), stderr: "", interrupted: false },
    },
    root,
  );

  assert.ok(out, "a large Bash result must be pruned");
  const uo = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof uo, "object", "Bash shape round-trips as an object");
  assert.match(uo.stdout, /\[ctxkeep\]/, "the pruned text lands back in stdout");
});

test("post-tool-use passes a short result through untouched (no output)", () => {
  const root = scratch();
  const out = runHook(
    "post-tool-use.js",
    {
      session_id: "s-short",
      tool_name: "Bash",
      tool_use_id: "toolu_short",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n", stderr: "", interrupted: false },
    },
    root,
  );
  assert.equal(out, null, "a short result must not be rewritten");
});

test("post-tool-use skips a neverPrune tool even when large", () => {
  const root = scratch();
  const out = runHook(
    "post-tool-use.js",
    {
      session_id: "s-edit",
      tool_name: "Edit",
      tool_use_id: "toolu_edit",
      tool_input: { file_path: "/repo/x.js" },
      tool_response: { stdout: bigOutput() },
    },
    root,
  );
  assert.equal(out, null, "Edit is on neverPrune; its result must pass through");
});

// --- PreToolUse: dedupe ------------------------------------------------------

test("pre-tool-use denies a re-read of an unchanged file read this session", () => {
  const root = scratch();
  const file = join(root, "src.js");
  writeFileSync(file, bigOutput(), "utf8");
  // Pin mtime to the past so it is unambiguously older than the recorded read.
  const past = Date.now() / 1000 - 3600;
  utimesSync(file, past, past);

  // First read: PostToolUse records it in session state.
  runHook(
    "post-tool-use.js",
    {
      session_id: "s-dedupe",
      tool_name: "Read",
      tool_use_id: "toolu_first",
      tool_input: { file_path: file },
      tool_response: { type: "text", file: { filePath: file, content: bigOutput() } },
    },
    root,
  );

  // Second read of the same unchanged file: PreToolUse must deny it.
  const out = runHook(
    "pre-tool-use.js",
    { session_id: "s-dedupe", tool_name: "Read", tool_input: { file_path: file } },
    root,
  );

  assert.ok(out, "a repeat read of an unchanged file must be denied");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /already read in this session/);
});

test("pre-tool-use stays silent for a file never read this session", () => {
  const root = scratch();
  const out = runHook(
    "pre-tool-use.js",
    { session_id: "s-new", tool_name: "Read", tool_input: { file_path: join(root, "never.js") } },
    root,
  );
  assert.equal(out, null, "a first read must be allowed through");
});

test("pre-tool-use denies an offset re-read of lines already delivered", () => {
  // NEW CONTRACT: identity, not call-shape. An offset read of lines a prior
  // whole-file read already delivered is a duplicate. (The old rule exempted
  // every offset/limit read, which is why dedupe never fired.)
  const root = scratch();
  const file = join(root, "src.js");
  writeFileSync(file, bigOutput(), "utf8");

  runHook(
    "post-tool-use.js",
    {
      session_id: "s-offset-seen",
      tool_name: "Read",
      tool_use_id: "toolu_w",
      tool_input: { file_path: file },
      tool_response: { type: "text", file: { filePath: file, content: bigOutput() } },
    },
    root,
  );

  const out = runHook(
    "pre-tool-use.js",
    { session_id: "s-offset-seen", tool_name: "Read", tool_input: { file_path: file, offset: 10, limit: 20 } },
    root,
  );
  assert.ok(out, "an offset re-read of seen lines must be denied");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("pre-tool-use allows a read of a region not yet seen", () => {
  // CONSTRAINT 1: only the first 50 lines were read; a read past them is new.
  const root = scratch();
  const file = join(root, "src.js");
  writeFileSync(file, bigOutput(), "utf8");

  runHook(
    "post-tool-use.js",
    {
      session_id: "s-new-region",
      tool_name: "Read",
      tool_use_id: "toolu_head",
      tool_input: { file_path: file, offset: 1, limit: 50 },
      tool_response: { type: "text", file: { filePath: file, content: bigOutput() } },
    },
    root,
  );

  const out = runHook(
    "pre-tool-use.js",
    { session_id: "s-new-region", tool_name: "Read", tool_input: { file_path: file, offset: 100, limit: 40 } },
    root,
  );
  assert.equal(out, null, "a genuinely new region must be allowed through");
});

test("post-tool-use flags a shell read that routes around a dedupe denial", () => {
  // CONSTRAINT 2 instrumentation: a denial the agent bypasses with a shell read
  // of the same path cost a turn and saved nothing — record it as net-negative.
  const root = scratch();
  const file = join(root, "src.js");
  writeFileSync(file, bigOutput(), "utf8");

  runHook(
    "post-tool-use.js",
    {
      session_id: "s-routed",
      tool_name: "Read",
      tool_use_id: "toolu_r",
      tool_input: { file_path: file },
      tool_response: { type: "text", file: { filePath: file, content: bigOutput() } },
    },
    root,
  );
  const denied = runHook(
    "pre-tool-use.js",
    { session_id: "s-routed", tool_name: "Read", tool_input: { file_path: file } },
    root,
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

  runHook(
    "post-tool-use.js",
    {
      session_id: "s-routed",
      tool_name: "Bash",
      tool_use_id: "toolu_b",
      tool_input: { command: `cat ${file}` },
      tool_response: { type: "text", stdout: bigOutput() },
    },
    root,
  );

  const ledger = readFileSync(join(root, ".ctxkeep", "metrics.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    ledger.some((m) => m.kind === "dedupe_routed" && m.path === file),
    "a shell read of a denied path must be recorded as routed-around",
  );
});

// --- SessionStart: inject memory --------------------------------------------

test("session-start injects the non-empty sections of CONTEXT.md", () => {
  const root = scratch();
  writeFileSync(
    join(root, "CONTEXT.md"),
    "# Project context\n\n## Decisions\n\n- picked ESM, a settled decision\n\n## Constraints\n\n",
    "utf8",
  );

  const out = runHook("session-start.js", { session_id: "s-mem", source: "startup" }, root);

  assert.ok(out, "a populated CONTEXT.md must produce an injection");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Accumulated context for this project/, "must use the statement framing");
  assert.match(ctx, /settled decision/, "the Decisions entry must be injected");
  assert.doesNotMatch(ctx, /## Constraints/, "an empty section must be dropped");
});

test("session-start stays silent when CONTEXT.md is absent", () => {
  const root = scratch();
  const out = runHook("session-start.js", { session_id: "s-nomem", source: "startup" }, root);
  assert.equal(out, null, "no memory file means nothing to inject");
});

// --- Fail-open path (ARCHITECTURE.md §7) ------------------------------------

test("every hook fails open on malformed stdin: exit 0, no output", () => {
  const root = scratch();
  for (const name of HOOK_FILES) {
    const res = runRaw(name, "{ this is : not json", root);
    assert.equal(res.status, 0, `${name} must exit 0 on garbage input`);
    assert.equal(res.stdout.trim(), "", `${name} must print nothing on garbage input`);
  }
});

test("every hook fails open with no config file present: exit 0, no output", () => {
  // A fresh project dir has no .ctxkeep.json. The hooks must degrade to a silent
  // no-op on an inert payload rather than error because config is absent.
  const root = scratch();
  for (const name of HOOK_FILES) {
    const res = runRaw(name, "{}", root);
    assert.equal(res.status, 0, `${name} must exit 0 with no config file`);
    assert.equal(res.stdout.trim(), "", `${name} must print nothing with no config file`);
  }
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test(
  "every hook fails open when the cache directory is unwritable: exit 0, no output",
  { skip: isRoot ? "chmod is bypassed when running as root" : false },
  () => {
    // Payloads chosen so each hook actually reaches for the cache: post writes an
    // artifact, pre-tool-use and pre-compact replay the state log, session-start
    // stamps state and sweeps. An EACCES from the 000 cache dir must never
    // surface as a broken session.
    const cases = [
      [
        "post-tool-use.js",
        {
          session_id: "s",
          tool_name: "Read",
          tool_use_id: "toolu_x",
          tool_input: { file_path: "/repo/big.js" },
          tool_response: { type: "text", file: { filePath: "/repo/big.js", content: bigOutput() } },
        },
      ],
      ["pre-tool-use.js", { session_id: "s", tool_name: "Read", tool_input: { file_path: "/repo/x.js" } }],
      ["session-start.js", { session_id: "s", source: "startup" }],
      ["pre-compact.js", { session_id: "s", trigger: "auto" }],
    ];

    for (const [name, input] of cases) {
      const root = scratch();
      const cacheRoot = join(root, ".ctxkeep");
      mkdirSync(cacheRoot);
      chmodSync(cacheRoot, 0o000);
      try {
        const res = runRaw(name, JSON.stringify(input), root);
        assert.equal(res.status, 0, `${name} must exit 0 with an unwritable cache. stderr: ${res.stderr}`);
        assert.equal(res.stdout.trim(), "", `${name} must print nothing with an unwritable cache`);
      } finally {
        chmodSync(cacheRoot, 0o755); // restore so the temp dir can be cleaned up
      }
    }
  },
);
