# BLOCKED — decisions that need Louis

These Phase 0 tasks require a human decision or an action the working agreement
says an agent must not take autonomously. Each entry states the research done, a
recommendation, and exactly what remains for you to decide or run.

---

## 0.1 — Settle the name  *(needs your choice)*

**The problem.** The project answers to two names at once:

| Surface | Current value |
|---|---|
| repo directory | `HyperCompressor` |
| `package.json` `name` / `bin` | `ctxkeep` |
| `plugin.json` `name` | `ctxkeep` |
| skill directory | `skills/ctxkeep/` |
| config filename | `.ctxkeep.json` |
| cache dir default | `.ctxkeep/` |
| docs (README, TESTING, CLAUDE, CONTEXT) | `ctxkeep` |

`ctxkeep` appears **97 times across 17 files**; `hypercompressor` appears only in
`TASKS.md`, `LAUNCH.md`, and as the absolute path inside `.claude/settings.json`.

**npm availability (checked against the live registry on 2026-08-31):**

| Candidate | npm status |
|---|---|
| `ctxkeep` | **FREE** |
| `hypercompressor` | **FREE** |
| `context-keep` | **FREE** |
| `ctxkeep-cli` | **FREE** |
| `ctx-keep` | **FREE** |

All are available, so npm does not force the decision. Verify any final pick
yourself with `npm view <name> version` (empty output = free).

**Recommendation: `ctxkeep`.** It already accounts for 97 of the 98 name
references, so choosing it makes 0.1 almost a no-op (only the repo directory and
the stray `hypercompressor` mentions change). It is descriptive of what the tool
does, and it is free on npm. `hypercompressor` oversells (it does head/tail
elision, not compression) and would force renaming all 17 files.

**What I need from you:** pick the name. I did **not** rename anything, per your
instruction that this choice is yours.

**Scope once you decide** (so the rename is a single sweep): repo directory,
`package.json` `name` + `bin`, `plugin.json` `name`, `skills/<name>/` dir,
`.<name>.json` config filename **and** its references in `src/config.js`
(`cacheDir`, `.ctxkeep.json` load path), the `.<name>/` cache-dir default,
`passthroughPaths`, the `[ctxkeep]` pointer string in `src/prune/index.js`, hook
description strings in `hooks/hooks.json`, and all doc mentions.

**Done-when (from TASKS.md):** `grep -ril "ctxkeep\|hypercompressor" . --exclude-dir=.git`
returns only the chosen name. Currently returns both — will stay unsatisfied
until you choose and the sweep runs.
