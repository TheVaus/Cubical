> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../architecture/) and [`docs/implementation/`](../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Cubical — Workflow Review (Segment 2: AI tooling loop) — 2026-05-17

### 1. Summary

The human+AI loop is **healthy and disciplined**: 59 commits, all Conventional-Commits-compliant, one-logical-change each, with genuinely informative bodies (the two perf commits explain *why* in full). Sessions map cleanly to one feature surface, layer transitions are tagged (`l0`, `l1`), and the developer works in a single checkout with no stray worktrees — exactly the stated model. The friction is almost entirely **configuration that was never set up**: there is no `.claude/settings.json` at all, so every `cargo test`/`clippy`/`fmt` and `git` read-only command prompts for permission every session, and the `cargo fmt`-clean rule is enforced by hand.

What's working well: commit hygiene, session scoping, the layer-2 spec as a session brief, the verify-before-start checklist, a green test baseline.

Counts: **4 Config** findings, **2 Worktree/branch** findings, **3 Session-process** findings, **3 CLAUDE.md/spec** findings. All test suites pass (121 Rust + 46 vitest).

---

### 2. Recommendations

#### Config (settings / hooks) — highest leverage

**C1 — Create `.claude/settings.json` with a read-only permission allowlist.** *(trivial · high confidence)*
There is no `settings.json` in `.claude/` (only `launch.json`). Every routine command in every session triggers an approval prompt. Add:

```json
{
  "permissions": {
    "allow": [
      "Bash(cargo test:*)",
      "Bash(cargo clippy:*)",
      "Bash(cargo fmt:*)",
      "Bash(cargo build:*)",
      "Bash(cargo check:*)",
      "Bash(npm test:*)",
      "Bash(npm run build:*)",
      "Bash(npm run dev:*)",
      "Bash(npm --prefix ui run:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git branch:*)"
    ]
  }
}
```
Removes: a permission prompt on essentially every verification command, several times per session.

**C2 — Add a `PostToolUse` hook that auto-formats edited Rust files.** *(small · high confidence)*
CLAUDE.md mandates "`cargo fmt` … clean before any commit"; today that is a manual step the agent must remember. In `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && cargo fmt --quiet 2>/dev/null || true" }
        ]
      }
    ]
  }
}
```
Removes: the recurring "did I run fmt?" step and fmt-only follow-up commits. (Keep it `|| true` so a transient failure never blocks an edit.)

**C3 — Track `.claude/settings.json` in git; gitignore the local override.** *(trivial · high confidence)*
`.claude/` is currently entirely untracked (`?? .claude/`). Once C1/C2 land, `git add .claude/settings.json .claude/launch.json` so the allowlist and hooks travel with the repo, and add `\.claude/settings.local.json` to `.gitignore` for machine-specific overrides.

**C4 — Set `cargo` env for faster, quieter session loops.** *(trivial · medium confidence)*
Add to `settings.json` `"env"`: `{ "CARGO_TERM_COLOR": "never" }` — keeps `cargo` output free of ANSI codes that bloat tool-result context. (Optional; lower value than C1–C3.)

#### Worktree / branch hygiene

**W1 — Delete the stale remote branch `claude/romantic-neumann-472f93`.** *(trivial · high confidence)*
`git rev-list` shows it is **0 commits ahead** of `main` and 20 behind — fully abandoned. It clutters `git branch -a` and is a "wrong branch" hazard:
```
git push origin --delete claude/romantic-neumann-472f93
```

**W2 — Delete the `archive/pensive-rubin-69259c9` tag.** *(trivial · high confidence)*
`git log --all` shows four duplicated commit pairs (`docs: restructure documentation`, `fix three post-restructure defects`, `fix section discontinuity notices`, `docs(l0) … close out Layer 0` each appear twice). They trace to `4faab9a merge: bring L0 smoke pass + L1 Session B closure onto worktree branch` — work was done on a worktree branch that had diverged, then **merged** instead of rebased, duplicating the commits; `archive/pensive-rubin-69259c9` preserves the dead line. Root cause is historical (the pre-current-cadence doc restructure) and not recurring. Drop the tag so `git log --all` stops showing ghosts:
```
git tag -d archive/pensive-rubin-69259c9
```
Note for future: when a side branch diverges from `main`, rebase before merging to avoid duplicate history.

*Healthy:* `git worktree list` shows only the main checkout — the single-checkout-plus-branches model is being followed exactly. No action.

#### Session process

**S1 — Out-of-cadence merges must also rewrite the "Project state" block.** *(small · high confidence)*
The `fix-large-vault-perf` branch (commits `e64e2ac`, `8b810ef`, merge `ec49953`) shipped a virtualized file list + batched scan writes, but **CLAUDE.md "Project state" never mentions it** — the closeout protocol ("rewrite the Project state block") was skipped because this was a bugfix branch, not a numbered session. Make the rule: *any merge to `main`* updates Project state, not only layer sessions. Add the perf work to the current state block now.

**S2 — Fix the stale test baseline in CLAUDE.md.** *(trivial · high confidence)*
CLAUDE.md records "121 Rust + 41 vitest"; actual is **121 Rust + 46 vitest** (verified: the `fix-large-vault-perf` merge added `ui/src/virtualList.test.ts`, 5 tests, never folded into the count). Update to `46 vitest`. This is the same omission as S1 — the perf merge didn't touch CLAUDE.md at all.

**S3 — Watch the deferred-doc backlog before Session G.** *(small · medium confidence)*
Layer-2 spec §9.2 (Session B) and §9.4 (Session D) are one-paragraph stubs that explicitly say "Full write-up is Session G's closeout job." With E and F still to come, Session G inherits write-ups for four sessions plus the smoke pass plus the `l2` tag — a bundle that risks exceeding the "one feature surface per session" cadence. Recommend: write the §9.x prose at each session's own close (it is fresh then), leaving Session G only the interactive smoke + tag.

#### CLAUDE.md / specs

**M1 — Fix the dangling `docs/superpowers/specs/` pointer and version planning artifacts.** *(trivial · high confidence)*
`docs/README.md` lists `docs/superpowers/specs/` and `docs/superpowers/plans/` as canonical, but only `plans/` exists (one file: `2026-05-12-doc-restructure.md`) and the whole `docs/superpowers/` tree is **untracked** (`?? docs/superpowers/`). Either create `specs/` or remove the line, then `git add docs/superpowers/` so planning artifacts are versioned like the docs that reference them.

**M2 — Refresh the "Project state" block.** *(trivial · high confidence)*
Covered by S1/S2: add the large-vault perf work, correct the vitest count to 46.

**M3 — CLAUDE.md is otherwise well-sized.** *(no action)*
~7.3 KB, high signal density, "Non-negotiables" and "Build order" are exactly the load-bearing facts a fresh agent needs. The "Next" line and layer-spec pointers give a cold-start agent a clear entry point. No bloat found.

---

### 3. Checked and healthy

- **Commit hygiene** — 59 commits, all Conventional-Commits, one logical change each; bodies explain *why* (the two perf commits are exemplary). No malformed messages found.
- **Session scoping** — commit clusters map cleanly to one feature surface each (write-path, decorations, settings IPC, theming); per-session merge commits make the boundaries explicit.
- **Worktree model** — single main checkout, no stray worktrees; matches the stated single-checkout-plus-branches preference.
- **Layer tagging** — `l0` and `l1` present and correctly placed; `l2` correctly absent (Session G pending).
- **Layer-2 spec as a session brief** — strong model: every session has Scope, DoD bullets, Prereqs, and an explicit "Out of scope" list; §6 carries a verify-before-start checklist ("L1 carry-over interactive smoke pass … Filed as bug against L1 if any step failed"). This is the template; keep using it.
- **Test baseline** — `cargo test --workspace` 121 pass / 0 fail; `npm test` 46 pass / 0 fail. Green and consistent with reality (modulo the count-only staleness in M2).
