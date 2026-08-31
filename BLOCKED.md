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

---

## 0.3 — Purge kickbacks artifacts from git history  *(needs a force-push you must run)*

**Done in the working tree** (committed on `phase-0-repo-fixes`): `kickbacks-inspect/`
and `kickbacks-v2.vsix` are `git rm`'d and `*.vsix` is gitignored.

**Still blocked.** The files remain in history commit `14edbd7` ("First tests"),
so the task's `git log --all --name-only | grep -c vsix` still returns `2`, not
`0`. Reaching `0` requires rewriting history, which per your instruction I did
**not** do. A remote exists (`origin` → github.com/louisslnn/HyperCompressor.git),
so the rewrite also needs a force-push.

Run one of these yourself once you've confirmed no one else has pulled the repo.

**Option A — squash all history into one clean commit (simplest; the task's own
suggestion, sound because history is tiny):**

```bash
git checkout main                       # land the working-tree cleanup on main first
git merge --ff-only phase-0-repo-fixes  # or cherry-pick the 0.x commits
git checkout --orphan clean             # new root with no parents
git add -A
git commit -m "Initial commit"          # single commit, current clean tree
git branch -D main
git branch -m clean main
git push --force-with-lease origin main
```

**Option B — surgically strip only the kickbacks paths, preserving other history:**

```bash
brew install git-filter-repo            # or: pipx install git-filter-repo
git filter-repo --path kickbacks-inspect --path kickbacks-v2.vsix --invert-paths
git remote add origin https://github.com/louisslnn/HyperCompressor.git  # filter-repo drops the remote
git push --force-with-lease origin --all
```

**Verify after either:** `git log --all --name-only | grep -c vsix` → `0`.

Notes: use `--force-with-lease`, never a bare `--force`. If the repo is private
and unpulled, the blob is low-risk but still bloats the pack. If the `.vsix` was
ever pushed to a public remote, treat its contents as already disclosed —
rewriting removes it from the tip, not from anyone's existing clone or GitHub's
cached views.
