> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

<!-- Purpose: parked plan for a FUTURE agent to execute BETWEEN layers — adopts agent-workflow doc surfaces (inbox, roadmap, open-questions, active-context, core-docs pointer hub) onto Cubical's existing docs, without touching the code tree. Do not run mid-layer. -->

# Agent-Workflow Docs Adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the valuable parts of a generic "agent-friendly monorepo" template — async-comms, a dependency-aware roadmap, a live known-issues surface, and codified workflow rules — *layered onto* Cubical's existing docs system, without touching the code tree or duplicating the architecture canon.

**Architecture:** Docs-only change. Add four new surfaces (`inbox.md`, `open-questions.md`, `roadmap.md`, `active-context/known-issues.md`), a thin pointer hub (`core-docs/`) that designates the *existing* CLAUDE.md non-negotiables + `architecture/` + `conventions.md` as the source of truth (no content copied → no drift), merge the workflow rules into `CLAUDE.md` as new sections, and index everything in `docs/README.md`. The `crates/` + `ui/` code layout is left untouched; logs/handoffs reuse the existing `docs/superpowers/` flow.

**Tech Stack:** Markdown only. No build, no code, no tests touched. Git on `main` via a feature branch (this repo uses branches in the single checkout — **never** `git worktree`).

---

## Why this shape (read before executing)

This plan is the architect-reviewed *hybrid* of a restructure proposal. The proposal was a generic web-app template (`code/backend|frontend|db`, centralized `tests/`, a `core-docs/` content canon, flat `logs/`+`handoffs/`). For a Tauri/Rust/Solid local-first app most of the *code* half is a regression; only the *workflow* half carries value. This plan implements only the value.

**Deliberate deviations from the verbatim template — do NOT "fix" these:**

- **No `code/` tree, no `code/backend|frontend|db`.** `crates/` (6-member Cargo workspace) and `ui/` (Solid+Vite) are already the idiomatic Tauri monorepo layout. Moving them rewrites `Cargo.toml`, `crates/cubical-app/tauri.conf.json`, `ui/vite.config.ts`, `package.json`, `.gitignore`, resets `git blame`, and buys nothing.
- **No `code/db/`.** Cubical's #1 non-negotiable: `.md` files are the source of truth; libSQL is *derived* state whose schema lives inside `cubical-index`. A top-level `db/` would contradict the architecture.
- **No centralized `tests/`.** Rust tests are inline `#[cfg(test)]` + per-crate `tests/` (e.g. `crates/cubical-ast/tests/`); vitest specs are colocated in `ui/src/`. CLAUDE.md requires each library crate to be independently testable — that depends on tests living in the crate.
- **No `docs/logs/` or `docs/handoffs/` dirs.** The existing `docs/superpowers/` flow (`*-kickoff.md` = handoff in, `prompts/*-closeout.md` = log out, `plans/`) is a richer version of the same idea. We reuse it and only adopt the naming convention.
- **`core-docs/` holds pointers, not copies.** Copying the non-negotiables/architecture into a new canon would create two sources of truth that drift. `core-docs/` is a thin index *pointing at* the real canon (CLAUDE.md + `architecture/` + `conventions.md`).
- **`CLAUDE.md` is merged, not overwritten.** It is the real master primer (non-negotiables, repo layout, session protocol, project-state with hard-won methodology notes). The template's "master AI rules" are thinner; we add them as new sections.
- **`brand.md` is a placeholder by design.** Cubical is a local-first desktop tool with no brand layer yet; the file exists to satisfy the workflow rule's "check before generating UI," and points at `architecture/ui.md`.

---

## Setup (do once, before Task 1)

- [ ] **Step 0: Create the working branch**

This repo uses branches in the single checkout — do NOT create a git worktree.

Run:
```bash
cd /Users/user/Developer/Cubical
git checkout main && git pull --ff-only 2>/dev/null; git checkout -b docs/agent-workflow-adoption
```
Expected: switched to a new branch `docs/agent-workflow-adoption`.

---

## Task 1: Async-comms drop-zones (`inbox.md`, `open-questions.md`)

**Files:**
- Create: `docs/inbox.md`
- Create: `docs/open-questions.md`

- [ ] **Step 1: Create `docs/inbox.md`**

```markdown
# Inbox

> Your drop-zone. Write feature requests, bugs, or stray notes here — one per line or paragraph, no formatting required. The agent only **reads and deletes** this file; it never writes here.
>
> Say "process the inbox" and the agent will translate each item into a `[T-XXX]` task in [`roadmap.md`](roadmap.md) (or fix the named bug), then delete the processed text so nothing is handled twice.

<!-- Drop items below this line -->
```

- [ ] **Step 2: Create `docs/open-questions.md`**

```markdown
# Open Questions

> Non-blocking questions from the agent to the user. When the agent hits an ambiguity or a long-horizon decision that doesn't block current work, it records the question here and keeps going. Check this file at the start of a session and answer inline under each question.
>
> Format: agent appends a `## [date] question`; user replies under it. The agent removes resolved questions once the answer is folded into the relevant doc or task.

<!-- No open questions. -->
```

- [ ] **Step 3: Verify both files exist**

Run: `ls docs/inbox.md docs/open-questions.md`
Expected: both paths listed, no error.

- [ ] **Step 4: Commit**

```bash
git add docs/inbox.md docs/open-questions.md
git commit -m "docs(workflow): add inbox + open-questions async drop-zones"
```

---

## Task 2: Seeded roadmap (`roadmap.md`)

**Files:**
- Create: `docs/roadmap.md`

Seeded from real current work as of L4-A-fix close (2026-06-06): the deferred embed scroll-jump fix, L4-B (next layer), L4-C/Omni-Bar with the deferred Contract C navigation split, and the two standing backfills. Indentation encodes the dependency tree; a child cannot start until its parent is complete.

- [ ] **Step 1: Create `docs/roadmap.md`**

```markdown
# Roadmap

Strict dependency tree. **A child (indented) task cannot start until its parent is marked complete.** Every task has an id `[T-XXX]` and a T-shirt size `[Size: S|M|L|XL]`. Mark completion by checking the box. New work enters here (often via "process the inbox"). For deep context on any task, grep `docs/superpowers/prompts/` and the layer specs for its id.

> Relationship to [`build-order.md`](build-order.md): build-order is the coarse *layer* ladder (the locked sequence of layers). This roadmap is the finer *task* tree within and across the active layers. When they disagree about sequence, build-order wins.

## Active

- [ ] [T-001] [Size: M] Fix embed re-render scroll-jump on autosave (own-write invalidation)
      — autosave's own-write watcher event unconditionally invalidates the embed
      cache, remounting every embed (height thrash) and jumping the viewport to top
      while the cursor stays put. Root cause + fix options in `layer-4-spec.md` §9.2;
      live detail in `active-context/known-issues.md`. Recommended before T-002.
- [ ] [T-002] [Size: L] L4-B — persistent left-panel search results UI (Requires T-001)
  - [ ] [T-003] [Size: M] Wire L4-A search IPC into a left-panel results store (Requires T-002)
  - [ ] [T-004] [Size: M] Render results list: click-to-open + match highlighting (Requires T-003)
- [ ] [T-005] [Size: L] L4-C — Omni-Bar
  - [ ] [T-006] [Size: M] Navigation path split / funnel — deferred Contract C, bugs #2/#3
        (Requires T-005; not reproducing against the live vault as of L4-A-fix, revisit
        when the Omni-Bar surfaces the funnel as load-bearing)

## Standing backfills (independent; run when the next session touches the surface)

- [ ] [T-007] [Size: S] Backfill L4-A search recipes
- [ ] [T-008] [Size: S] Backfill L1/L2 watcher + properties recipes
```

- [ ] **Step 2: Verify the file exists and the tree renders**

Run: `sed -n '1,40p' docs/roadmap.md`
Expected: the header plus the `[T-001]`…`[T-008]` tree, indentation intact.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(workflow): add seeded T-XXX roadmap dependency tree"
```

---

## Task 3: Live known-issues surface (`active-context/`)

**Files:**
- Create: `docs/active-context/known-issues.md`

Consolidates the known-issue currently scattered across CLAUDE.md's project-state block and `layer-4-spec.md` §9.2 into one live surface. This is the provisional tier of the truth hierarchy — it never overrides `architecture/`.

- [ ] **Step 1: Create `docs/active-context/known-issues.md`**

```markdown
# Active Context — Known Issues

> Live scratchpad for in-flight bugs and unresolved issues. **Provisional**: this tier never overrides `docs/architecture/` or the CLAUDE.md non-negotiables. When an issue is fixed, move it to the relevant layer spec / log and delete it here.

## KI-1 — Embed re-render scroll-jump on autosave  → tracked as [T-001]

**Symptom:** Typing in a file that contains a rendered `![[…]]` embed occasionally
jumps the viewport to the top of the document. The cursor itself stays put.

**Root cause:** Autosave writes the file, which fires an own-write event on the
file watcher. The watcher handler *unconditionally* invalidates the embed cache,
which remounts every embed widget. The remount causes block-height thrash, and
CodeMirror recomputes the viewport to the top.

**Where documented:** root cause + fix options in `../layer-4-spec.md` §9.2.

**Fix direction (not yet chosen):** either (a) distinguish own-write watcher
events from genuine external edits and skip embed-cache invalidation for own
writes, or (b) make invalidation height-stable so the remount doesn't thrash
layout. Decide during T-001.

**Status:** Deferred from L4-A-fix (closed 2026-06-06, `l4a-fix`). Recommended as a
focused follow-up before L4-B (T-002).
```

- [ ] **Step 2: Verify**

Run: `ls docs/active-context/ && head -3 docs/active-context/known-issues.md`
Expected: `known-issues.md` listed; title line prints.

- [ ] **Step 3: Commit**

```bash
git add docs/active-context/known-issues.md
git commit -m "docs(workflow): add active-context known-issues (seeds KI-1 embed scroll-jump)"
```

---

## Task 4: Core-docs pointer hub (`core-docs/`)

**Files:**
- Create: `docs/core-docs/README.md`
- Create: `docs/core-docs/tech-stack.md`
- Create: `docs/core-docs/brand.md`

`core-docs/` is a **pointer hub**, not a content canon. It names where the real source of truth lives so the workflow rules can reference a stable path, without copying (and thus drifting from) the architecture docs.

- [ ] **Step 1: Create `docs/core-docs/README.md`**

```markdown
# Core Docs — Hierarchy of Truth

This folder does not hold the source of truth; it **points at** it, so other rules
can reference a stable location. Nothing here is copied from elsewhere — copies
drift. Read the originals.

**Order of authority (higher wins on conflict):**

1. **Locked design** — the Non-negotiables in [`../../CLAUDE.md`](../../CLAUDE.md)
   and [`../architecture/`](../architecture/) (split by domain). Never edit this
   tier without an explicit user command.
2. **Conventions + specs** — [`../conventions.md`](../conventions.md),
   [`../build-order.md`](../build-order.md), and the `../layer-N-spec.md` files.
3. **Provisional / live** — [`../active-context/`](../active-context/). Never
   overrides tiers 1–2.

Also here: [`tech-stack.md`](tech-stack.md) (pointer to the dependency manifests)
and [`brand.md`](brand.md) (UI/brand placeholder). Check both before adding
dependencies or generating UI.
```

- [ ] **Step 2: Create `docs/core-docs/tech-stack.md`**

```markdown
# Tech Stack (pointer)

> This is a snapshot + pointer, **not** the authoritative manifest. Before adding a
> dependency, edit the real manifest below — do not add deps to satisfy this file.

**Authoritative sources:**
- Rust workspace deps: [`../../Cargo.toml`](../../Cargo.toml) `[workspace.dependencies]` + each `crates/*/Cargo.toml`
- UI deps: [`../../ui/package.json`](../../ui/package.json)
- Code style + tooling: [`../conventions.md`](../conventions.md)

**Snapshot (verify against the manifests):**
- **Shell:** Tauri (desktop only for v1; no Electron, no Node runtime).
- **Backend libraries:** Rust, edition 2021, Cargo workspace of 6 crates —
  `cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`,
  `cubical-app` (the Tauri shell). The five non-`app` crates have no Tauri deps and
  build/test standalone.
- **Frontend:** Solid + TypeScript + Vite (`ui/`).
- **Key Rust deps:** tokio, serde / serde_yaml_ng, thiserror / anyhow, tracing,
  notify (+ debouncer-full), walkdir, libsql, sha2, pulldown-cmark, tantivy;
  tempfile (dev). `uuid` + `filetime` are intentionally deferred to L7.
```

- [ ] **Step 3: Create `docs/core-docs/brand.md`**

```markdown
# Brand (placeholder)

Cubical is a strictly local-first PKM desktop app. There is no formal brand layer
yet. Visual direction currently lives in [`../architecture/ui.md`](../architecture/ui.md)
and the UI styles under `ui/src/styles/`.

Check this file before generating UI. When a brand system is defined (colors, type
scale, iconography, voice), record it here and update `architecture/ui.md`.
```

- [ ] **Step 4: Verify links resolve (no broken relative paths)**

Run:
```bash
cd docs/core-docs && for f in ../../CLAUDE.md ../architecture ../conventions.md ../build-order.md ../active-context ../../Cargo.toml ../../ui/package.json ../architecture/ui.md; do [ -e "$f" ] && echo "OK $f" || echo "MISSING $f"; done; cd - >/dev/null
```
Expected: every line prints `OK …`. If any prints `MISSING`, fix the path in the file before committing.

- [ ] **Step 5: Commit**

```bash
git add docs/core-docs/
git commit -m "docs(workflow): add core-docs pointer hub (truth hierarchy, tech-stack, brand)"
```

---

## Task 5: Merge workflow rules into `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` — add a new "Agent workflow" section after the "Session protocol" section, and add Docs-index pointers. Do **not** touch Non-negotiables, Repository layout, or Project state.

- [ ] **Step 1: Read the current `CLAUDE.md` to locate insertion points**

Run: `grep -n '^## ' CLAUDE.md`
Expected: section headers including `## Docs`, `## Non-negotiables`, `## Session protocol`, `## Repository layout`, `## Project state`. Confirm `## Session protocol` and `## Repository layout` both exist; the new section goes between them.

- [ ] **Step 2: Add Docs-index pointers under the `## Docs` list**

Find the `## Docs` bullet list and append these four bullets to the end of that list (immediately before the next `---` or `##`):

```markdown
- **Roadmap:** `docs/roadmap.md` — the `[T-XXX]` task dependency tree (finer than build-order)
- **Inbox / Open questions:** `docs/inbox.md` (user → agent) · `docs/open-questions.md` (agent → user)
- **Active context:** `docs/active-context/` — live known issues / scratchpad (provisional tier)
- **Truth hierarchy:** `docs/core-docs/README.md` — pointer hub naming the source of truth
```

- [ ] **Step 3: Insert the new `## Agent workflow` section immediately before `## Repository layout`**

```markdown
## Agent workflow

Async collaboration + task-tracking rules. These primitives were adapted from a
generic agent-monorepo template onto Cubical's existing system — rationale and the
deliberate deviations are in
`docs/superpowers/plans/2026-06-06-agent-workflow-docs-adoption.md`.

- **Hierarchy of truth.** Authority order (higher wins): (1) Non-negotiables above
  + `docs/architecture/`; (2) `docs/conventions.md` + layer specs; (3)
  `docs/active-context/` (provisional). `docs/core-docs/README.md` indexes this.
  Never edit tier 1 without explicit user command.
- **Inbox (`docs/inbox.md`).** The user's drop-zone — the user writes, you only read
  and act. On "process the inbox," translate each note into a `[T-XXX]` roadmap task
  (or fix the named bug), then delete the processed text so it isn't handled twice.
- **Open questions (`docs/open-questions.md`).** For non-blocking ambiguities or
  long-horizon decisions: record the question, keep working. Check this file at
  session start for the user's answers.
- **Roadmap (`docs/roadmap.md`).** A strict dependency tree — an indented child task
  cannot start until its parent is complete. Every task carries `[T-XXX]` + a size
  `[Size: S|M|L|XL]`.
- **Logs + handoffs reuse `docs/superpowers/`.** That flow IS the log+handoff system —
  no parallel dirs. `*-kickoff.md` = handoff INTO a session; `prompts/*-closeout.md`
  = session log OUT; ending with incomplete work means writing the next-session
  prompt there. Name new closeouts `[TaskID]_[YYYY-MM-DD]_[brief].md` so logs are
  greppable by task id.
```

- [ ] **Step 4: Verify the section landed and the protected sections are untouched**

Run: `grep -n '^## ' CLAUDE.md`
Expected: `## Agent workflow` now appears between `## Session protocol` and `## Repository layout`. Confirm `## Non-negotiables`, `## Repository layout`, and `## Project state` are all still present and unchanged.

Run: `git diff CLAUDE.md | grep -E '^\-' | grep -v '^\-\-\-'`
Expected: **no removed lines** except blank-line shuffles — this is an additive edit. If any Non-negotiable / Repository-layout / Project-state content shows as removed, revert and redo as pure insertion.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(workflow): merge agent-workflow rules + index pointers into CLAUDE.md"
```

---

## Task 6: Wire new surfaces into the docs index

**Files:**
- Modify: `docs/README.md` — add rows to the "What kind of question do you have?" table.

- [ ] **Step 1: Add rows to the question table in `docs/README.md`**

Append these rows to the bottom of the existing markdown table (the one whose header is `| Question | Read |`):

```markdown
| I want to drop a feature request or bug | [`inbox.md`](inbox.md) |
| What's the prioritized task tree? | [`roadmap.md`](roadmap.md) |
| I (the agent) have a non-blocking question | [`open-questions.md`](open-questions.md) |
| What's broken or in-flight right now? | [`active-context/known-issues.md`](active-context/known-issues.md) |
| What's the source-of-truth hierarchy? | [`core-docs/README.md`](core-docs/README.md) |
```

- [ ] **Step 2: Verify the rows are present**

Run: `grep -nE 'inbox.md|roadmap.md|open-questions.md|active-context/known-issues.md|core-docs/README.md' docs/README.md`
Expected: five matches in the table.

- [ ] **Step 3: Commit**

```bash
git add docs/README.md
git commit -m "docs(workflow): index inbox/roadmap/open-questions/active-context/core-docs"
```

---

## Task 7: Final verification + integrate

**No code was touched**, so the six code gates (`cargo test/clippy/fmt`, `tsc`, `npm run build`, `vitest`) are unaffected and not required for this docs-only change. Verify doc integrity instead.

- [ ] **Step 1: Confirm the full target doc surface exists**

Run:
```bash
ls docs/inbox.md docs/open-questions.md docs/roadmap.md docs/active-context/known-issues.md docs/core-docs/README.md docs/core-docs/tech-stack.md docs/core-docs/brand.md
```
Expected: all seven paths listed, no error.

- [ ] **Step 2: Confirm no forbidden artifacts were created**

Run: `ls -d code core-docs tests docs/logs docs/handoffs 2>/dev/null; echo "exit=$?"`
Expected: nothing listed (only `exit=` with a nonzero status from the failed `ls`). If any of `code/`, root `core-docs/`, root `tests/`, `docs/logs/`, or `docs/handoffs/` exist, they were created in error — remove them (this plan deliberately omits them).

- [ ] **Step 3: Confirm the code tree is untouched**

Run: `git diff --name-only main -- crates ui Cargo.toml ui/package.json ui/vite.config.ts crates/cubical-app/tauri.conf.json`
Expected: **empty output** (no code/config files changed on this branch).

- [ ] **Step 4: Review the whole branch diff**

Run: `git diff --stat main`
Expected: only files under `docs/` plus `CLAUDE.md`. Confirm `CLAUDE.md` shows additions only.

- [ ] **Step 5: Integrate**

This is a docs-only branch; fast-forward or open a PR per the user's preference. Default — merge to `main` locally:
```bash
git checkout main && git merge --no-ff docs/agent-workflow-adoption -m "docs(workflow): adopt agent-workflow doc surfaces (hybrid restructure)"
```
Then push if the user wants it remote: `git push origin main` (origin = TheVaus/Cubical, SSH wired).

- [ ] **Step 6: Update the Project state block in `CLAUDE.md`**

Per the Session protocol, rewrite (don't append) the Project-state block to note the workflow-docs adoption landed, then commit:
```bash
git add CLAUDE.md && git commit -m "docs: update project state — agent-workflow docs adopted"
```

---

## Self-review (done at authoring time)

- **Spec coverage:** inbox ✓ (T1), open-questions ✓ (T1), roadmap as `[T-XXX]` tree ✓ (T2), active-context/known-bugs ✓ (T3), core-docs + tech-stack + brand ✓ (T4), master AI rules ✓ (T5, merged into CLAUDE.md per user's correction that it was always meant to be `CLAUDE.md`), architecture dir ✓ (already exists, designated in T4), logs/handoffs ✓ (reuse superpowers per user choice — T5 codifies it), docs index ✓ (T6). Code `backend/frontend/db`, `tests/`: **intentionally not implemented** — see "Why this shape" / deviations.
- **Placeholder scan:** every file's full content is inline; no TBD/TODO left for the executor.
- **Path consistency:** all relative links checked in T4 Step 4 and T6 Step 2; insertion targets in CLAUDE.md verified by `grep` in T5.
