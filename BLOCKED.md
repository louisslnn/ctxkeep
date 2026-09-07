# BLOCKED — decisions that need Louis

## 1.4 — Grep/Glob payloads not capturable in this environment  *(needs a session where those tools exist)*

Real `PostToolUse` payloads were captured from a live session for **Read, Bash,
WebFetch and one MCP tool** (`mcp__ide__getDiagnostics`) and committed under
`test/fixtures/payloads/`. `extractText` was narrowed to the confirmed shapes and
is tested against each in `test/payloads.test.js`.

**Not captured: `Grep` and `Glob`.** The agent session that did this work does not
expose the `Grep`/`Glob` tools at all (they are neither built-in nor in the
deferred-tool list here — only `Bash`, `Read`, etc. are available), so there was
no way to make Claude Code emit those two `tool_response` shapes. Per the task's
own instruction, they are **skipped rather than invented**.

**Exact procedure to finish, in a normal Claude Code session that has Grep/Glob:**

The plugin's `PostToolUse` hook is already registered for `Read|Bash|Grep|Glob|WebFetch`
and is spawned fresh (`node hooks/post-tool-use.js`) on every matching call, so a
capture line takes effect immediately — no restart needed:

1. Temporarily add, right after `const input = await readInput();` in
   `hooks/post-tool-use.js`:
   ```js
   try { (await import("node:fs")).appendFileSync("/tmp/ctxkeep-shapes.jsonl", JSON.stringify(input) + "\n"); } catch {}
   ```
   (Or use the README's throwaway `settings.local.json` logging hook and restart.)
2. Run one `Grep` (e.g. search a pattern across `src/`) and one `Glob`
   (e.g. `**/*.js`).
3. Read `/tmp/ctxkeep-shapes.jsonl`, pull the entries whose `tool_name` is
   `Grep` and `Glob`, and save them as `test/fixtures/payloads/grep.json` and
   `glob.json` (whole hook stdin payload, faithful shape).
4. **Revert the capture line.** Add the observed shapes to the confirmed list in
   `src/io.js` `extractText` if they differ, and add assertions to
   `test/payloads.test.js` (the "every committed payload fixture" test already
   generalises to any new fixture).

Until then the fallback probe in `extractText` covers `Grep`/`Glob` — both return
string content that the fallback keys (`content`/`output`/`text`) or a bare
string will pick up — so nothing is broken; the shapes are just unconfirmed.

---


These Phase 0 tasks require a human decision or an action the working agreement
says an agent must not take autonomously. Each entry states the research done, a
recommendation, and exactly what remains for you to decide or run.

---

## 0.1 — Settle the name  *(resolved)*

**Resolved.** The name is `ctxkeep`, and the sweep is done — every surface
(package `name`/`bin`, plugin name, `skills/ctxkeep/`, `.ctxkeep.json`, the
cache-dir default, `passthroughPaths`, the `[ctxkeep]` pointer, hook
descriptions, and all docs and fixtures) agrees. A case-insensitive sweep for
the old name now returns nothing. `.claude/settings.json` no longer hardcodes an
absolute path; it uses `${CLAUDE_PROJECT_DIR}`.

The one surface left is the **repo directory / GitHub repo rename**, which is a
git action for you. It also governs the `origin` URL referenced in 0.3 below and
the doc/marketplace slugs, which now read `ctxkeep` in anticipation of that
rename (GitHub redirects the old name once renamed).

---

## 0.3 — Purge kickbacks artifacts from git history  *(resolved)*

**Resolved.** The kickbacks artifacts are gone from all reachable history. The
original root commit that held them (`14edbd7`, "First tests") no longer exists —
history now begins at `d2a3ff6` → `3638dab`, and `git rev-list --all --objects`
finds no `kickbacks-inspect/` path or `.vsix` blob anywhere.

The only remaining residue was one commit *message* (`c8a964a`, "chore(0.3):
remove kickbacks artifacts…") whose body still named the extension file and
carried a now-false "they remain in history" note, so
`git log --all --name-only | grep -c vsix` returned `2`. That message was
reworded with `git filter-branch --msg-filter` on `phase-0-repo-fixes` (trees
byte-identical before/after — only the message changed) and the branch was
force-pushed with `--force-with-lease`. The filter-branch backup and reflog were
expired.

**Verified:** the blob is gone — `git rev-list --all --objects | grep -c vsix`
→ `0`. Note that `git log --all --name-only | grep -c vsix` is **not** `0`: the
release-closure commit messages (this file's commit, the CHANGELOG entry) mention
the word while *documenting* the purge. Those are commit-message text, not
artifacts, and they are left as-is deliberately — chasing literal `0` would mean
rewording history to avoid a word. Settled; do not re-investigate.

Caveat retained from the original note: if the `.vsix` was ever fetched from a
public remote before the purge, treat its contents as already disclosed —
rewriting removes it from the repo, not from anyone's existing clone or GitHub's
cached views.

---

## 0.5 — Two false install claims in the README  *(resolved)*

**Resolved** by taking Option C: the README install section is now
source-install only. The unpublished `npm install -g ctxkeep` line and the
placeholder `/plugin install ctxkeep@your-marketplace` line are gone, with no
"coming soon" hedging. Every command in the new section was executed and
verified this session (`npm install -g .` from the checkout, then `ctxkeep init`
and `ctxkeep doctor` in a throwaway project). The related savings-number honesty
fix landed alongside it — see the README eval-table disclaimer and
ARCHITECTURE.md §8.

Publishing to npm (old Option A) and standing up a plugin marketplace (old
Option B) remain **optional future work**, not blockers — revisit them after the
Phase 2.4 benchmark produces a number worth advertising. Both still need a
`repository` field in `package.json` and, for a marketplace, a
`.claude-plugin/marketplace.json` whose schema you confirm against current
Claude Code docs before committing it.
