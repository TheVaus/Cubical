# Cubical — Workflow Review (Segment 2: AI tooling loop) — 2026-05-18

### 1. Summary

The human+AI loop is healthy: 61 commits, all Conventional-Commits-compliant and one-logical-change, sessions scoped to one feature surface, layers tagged (`l0`, `l1`), single checkout with no stray worktrees — the stated cadence is being followed. Test baseline is green and accurate: `cargo test --workspace` = 121 pass / 0 fail, `npm test` = 46 pass / 0 fail, matching CLAUDE.md's recorded counts. **Applied: 1** (the permission allowlist, committed); **Suggested: 7** — all either destructive, behavior-changing, or judgment-laden, so left for the developer.

### 2. Applied

**A1 — `.claude/settings.json` permission allowlist committed (`d51522b`).**
The repo had no committed `.claude/settings.json`, so every routine read-only command prompted for approval each session. This pass added `Bash(npm run typecheck:*)` (proven read-only — `ui` script is `tsc --noEmit`) to the existing draft allowlist and committed the file:
```
chore: add Claude Code permission allowlist   (d51522b, 1 file, +21)
```
Validation: file parses as valid JSON, 15 `allow` entries, only additive (no entry removed or altered). Not pushed. Removes a per-command approval prompt on `cargo test/clippy/check/build`, `npm test/typecheck/build`, and `git status/log/diff/show/branch`.

Note: the allowlist also carries `cargo fmt:*`, `cargo build:*`, `npm run build:*`, `npm run dev:*` — not strictly read-only but non-destructive; they were in the pre-existing draft and were left untouched (APPLY rule: add only, never alter).

### 3. Suggested (not applied)

#### Config

**S1 — Optional `cargo fmt` formatting hook.** *(small effort · high confidence · REPORT-only: behavior-changing, opt-in)*
CLAUDE.md mandates "`cargo fmt` … clean before any commit" — a manual step today. If wanted, add to `.claude/settings.json`:
```json
"hooks": {
  "PostToolUse": [
    { "matcher": "Edit|Write",
      "hooks": [ { "type": "command",
        "command": "cd \"$CLAUDE_PROJECT_DIR\" && cargo fmt --quiet 2>/dev/null || true" } ] }
  ]
}
```
Removes: the recurring "did I fmt?" step and fmt-only follow-up commits. Not auto-applied because a hook changes session behavior and must be a deliberate opt-in.

#### Worktree / branch hygiene

**S2 — Delete the stale remote branch `claude/romantic-neumann-472f93`.** *(trivial · high confidence · REPORT-only: destructive)*
Verified: **0 commits ahead** of `main`, 20 behind — no unmerged work, nothing lost by removing it. It clutters `git branch -a` and is a wrong-branch hazard:
```
git push origin --delete claude/romantic-neumann-472f93
```
Not auto-applied: deleting a remote branch is destructive and is yours to run.

**S3 — Consider whether the `archive/pensive-rubin-69259c9` tag is still wanted.** *(trivial · medium confidence · REPORT-only: destructive + possibly intentional)*
The tag points at `69259c9`, which is **not reachable from `main`** — it preserves an abandoned line of history containing four commits later re-applied onto `main` (duplicate pairs visible in `git log --all`: `docs: restructure documentation`, `fix three post-restructure defects`, `fix section discontinuity notices`, `docs(l0) … close out Layer 0`). The `archive/` prefix strongly suggests this was kept **on purpose** as a safety anchor. If you no longer need it: `git tag -d archive/pensive-rubin-69259c9`. Left alone precisely because the name implies intent — confirm before deleting.

*Healthy:* `git worktree list` shows only the main checkout — the single-checkout-plus-branches model is intact.

#### Session process

**S4 — Out-of-cadence merges should also rewrite the "Project state" block.** *(small · high confidence · REPORT-only: judgment)*
The `fix-large-vault-perf` merge (`ec49953`) shipped virtualized-list + batched-scan work without updating CLAUDE.md's Project state, because it wasn't a numbered session. (A prior pass already drafted a fix — see S7.) Suggested rule: *any* merge to `main` updates Project state, not only layer sessions.

**S5 — Watch the deferred-doc backlog before Session G.** *(small · medium confidence · REPORT-only: judgment)*
Layer-2 spec §9.2 (Session B) and §9.4 (Session D) are one-paragraph stubs that say "Full write-up is Session G's closeout job." With E and F still pending, Session G inherits four write-ups plus the smoke pass plus the `l2` tag — a bundle that strains the one-surface-per-session cadence. Suggested: write each §9.x at its own session's close while context is fresh.

#### CLAUDE.md / specs

**S6 — `docs/superpowers/` is untracked.** *(trivial · high confidence · REPORT-only: judgment on what to version)*
`docs/README.md` lists `docs/superpowers/plans/` as canonical, but the whole `docs/superpowers/` tree is untracked (`?? docs/superpowers/`). If planning artifacts should be versioned alongside the docs that cite them: `git add docs/superpowers/`. Not auto-applied — staging files is a deliberate decision about what belongs in history.

**S7 — Commit (or revert) the pending CLAUDE.md / docs edits.** *(trivial · high confidence · REPORT-only: judgment)*
`git status` shows uncommitted edits to `CLAUDE.md` and `docs/README.md` from a prior fix pass: vitest count corrected `41 → 46`, the `fix-large-vault-perf` work added to Project state, and the dangling `docs/superpowers/specs/` pointer removed from `docs/README.md`. All three are verified-correct against the artifacts (test run confirms 46 vitest; `specs/` directory does not exist). They sit uncommitted — decide how to group and commit them:
```
git add CLAUDE.md docs/README.md
git commit -m "docs: correct test count + record perf work in project state"
```
Not auto-applied: CLAUDE.md edits are judgment-laden and commit grouping is yours.

### 4. Checked and healthy

- **Commit hygiene** — 61 commits, all Conventional-Commits, one logical change each; informative bodies (the two perf commits and `d8841fe refactor(core)` explain *why*). No malformed messages.
- **Session scoping** — commit clusters map cleanly to one feature surface; per-session merge commits mark the boundaries. `d8841fe` is a clean standalone refactor — not drift.
- **Worktree model** — single main checkout, no stray worktrees; matches the stated preference.
- **Layer tagging** — `l0`, `l1` correctly placed; `l2` correctly absent (Session G pending).
- **Layer-2 spec as a session brief** — every session has Scope, DoD bullets, Prereqs, and an explicit "Out of scope" list; §6 carries a verify-before-start checklist. Strong template; keep using it.
- **Test baseline** — 121 Rust + 46 vitest, all passing; CLAUDE.md's recorded counts now match reality.
- **Permission allowlist** — present and committed as of this pass (A1).
