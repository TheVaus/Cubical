# L3 Session B — Wiki-link Live Preview + click-to-navigate

L3 Session B for the Cubical project. The L2 Live Preview decoration
pipeline now extends to wiki-links; clicks on resolved links navigate;
clicks on unresolved links offer to create the target note. Builds on
the Session A index + `resolve_link` IPC. Do NOT start any further L3
work in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, "Project state" block.
   - `docs/README.md` — docs index.
   - `docs/layer-3-spec.md` — especially §1 goals 1 + 2, §2.2 (Wiki-link
     Live Preview + navigation), §3.1 (`resolve_link`), §4 (resolution),
     §5 (deviations), §8 Session B, and §9.1 (what Session A landed).
   - `docs/architecture/document-model.md` §5.2 (wiki-links) and §5.5
     (canonical AST + sanctioned editor-decoration exception).
   - `docs/conventions.md` — code style.

2. Read for context (skim, you'll come back to specific lines):
   - `ui/src/editor/decorations.ts` — the existing Live Preview
     decoration pipeline. Session B extends this.
   - `ui/src/Editor.tsx` and `ui/src/App.tsx` — the editor host and the
     file-open path the click handler will call into.
   - `ui/src/api/ipc.ts` — `resolveLink` wrapper landed in Session A.
   - `crates/cubical-ast/src/wikilink.rs` — internal tokenizer; useful
     reference for the grammar the Lezer inline rule must mirror.

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` →
     `Merge L3 Session A — wiki-link parsing + link index` (commit
     `f3e8cda`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`,
     `l1`, `l2`; does NOT contain `l3`.
   - CLAUDE.md "Project state" reports L3 Session A done, Sessions B–K
     pending. If not, STOP.

4. Baseline test counts (must match CLAUDE.md "Project state"):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace` →
     170 Rust tests green.
   - `cd ui && npx vitest run` → 127 vitest green.
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-b-wikilink-live-preview`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `using-superpowers` — ALWAYS, first.
- `writing-plans` — produces a fresh `docs/superpowers/plans/<date>-l3-session-b-wikilink-live-preview.md`
  from the L3 spec §2.2 + §8 Session B. Same shape as Session A's plan
  (`docs/superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md`).
- `executing-plans` (or `subagent-driven-development` if subagents are
  available) — works through the plan task-by-task with checkpoints.
- `test-driven-development` — every behaviour change lands with a
  failing test first, mirroring Session A. Decoration tests live next
  to `ui/src/editor/decorations.test.ts`; navigation tests run as
  vitest unit tests with mocked IPC.
- `verification-before-completion` — at the end, fresh test output and
  a recorded manual smoke pass against `cargo tauri dev` before any
  merge.
- `finishing-a-development-branch` — ALWAYS, at the very end.

SKIP `brainstorming` — Session B's scope is fully specified in
`docs/layer-3-spec.md` §2.2 + §8 Session B. If a sub-decision arises
that the spec doesn't pin down (e.g. exact CSS variable for the
unresolved-link warning state, exact UX of the "offer create" prompt),
raise it as an explicit decision in the plan rather than expanding
scope.

---

## STEP 2 — THE WORK (layer-3-spec.md §2.2 + §8 Session B)

In summary (full task breakdown lives in the plan written at STEP 1):

1. **Wiki-link decorations.** Extend `ui/src/editor/decorations.ts` to
   consume the `Inline::WikiLink` shape that landed at AST level in
   Session A. Off the cursor line: hide the brackets and any
   anchor/display markup, show the visible text (display if present,
   otherwise target) as an accent link. On the cursor line: raw
   `[[…]]` shows through (consistent with every other L2 decoration —
   §5.5 deviation, Live Preview *only*, the canonical AST is unchanged).
   Embeds (`![[…]]`) inherit the same on/off-cursor behaviour with an
   embed-indicator style (e.g. small inline icon or background tint
   per `ui.md`; finalise in the plan).

2. **Unresolved-link styling.** A wiki-link whose `resolve_link` IPC
   returns `target_path: null` renders in a distinct style — dashed
   underline + `--c-warning` per §2.2. Resolution is fetched on
   decoration build (debounced; one IPC call per unique target per
   doc) and cached for the editor lifetime; invalidate on
   `vault:file-changed` so a freshly-created target updates from
   "unresolved" to "resolved" without a reload.

3. **Click-to-navigate.** A click on a resolved link opens the target
   file via the existing file-open path used by the file tree. If the
   anchor is `Heading{value}`, scroll the editor to the matching
   heading after the file loads. If the anchor is `Block{value}`,
   scroll to the block — block-ref *resolution* is Session G's
   territory, so Session B's behaviour for block anchors on an
   otherwise-resolved target is acceptable to no-op with a debug log
   pending Session G.

4. **Click on unresolved → offer create.** A click on an unresolved
   link offers to create the note at the resolved-by-convention path
   (the inverse of resolution order: vault root + target + `.md`,
   unless the target already contains a `/`). The "offer" is whatever
   confirmation UX the plan settles on (a modal, an inline prompt, or
   a one-shot toast with an action) — finalise in the plan. After
   create, navigation proceeds as for a resolved link.

5. **Raw-source toggle interaction.** The L2 Session E raw-source
   toggle reveals literal source for all decorations; wiki-link
   decorations must respect that toggle. Add the regression to
   `ui/src/editor/decorations.test.ts` or a sibling.

6. **TypeScript + Rust tests.**
   - Decoration tests: each shape (`[[note]]`, `[[note|display]]`,
     `[[note#heading]]`, `[[note#^id]]`, `![[…]]`) decorates on the
     off-cursor line and reveals raw on the cursor line. Unresolved
     links carry the warning style.
   - Navigation tests: mock the IPC at the wrapper boundary; a click
     on a resolved link triggers the file-open handler with the
     expected path + anchor; a click on an unresolved link triggers
     the create-offer handler with the resolved-by-convention path.
   - Rust side: no new behaviour expected unless the plan uncovers a
     gap in `resolve_link` (e.g. anchor-only resolution against the
     current file). If a gap surfaces, file it explicitly — don't
     silently expand scope.

7. **Spec write-up.** Fill `docs/layer-3-spec.md` §9.2 (the "Session B
   — Live Preview + navigation" subsection) with what landed,
   mirroring §9.1's voice + structure.

8. **Project state.** Rewrite (do not append) the CLAUDE.md "Project
   state" block: layer 3, Sessions A + B done, Sessions C–K pending;
   final test counts; "Next" set to Session C — Backlinks panel +
   right-sidebar shell.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` →
  unchanged at 170 unless a Rust gap forced a test (document why).
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 127 baseline + N new tests; record the
  new count.
- `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo fmt --check` → clean (per `docs/conventions.md`).
- **Interactive smoke** against `cargo tauri dev` — a small test vault
  with: a note containing one of every wiki-link shape, a resolved
  link, an unresolved link, a heading anchor that scrolls correctly,
  and an embed. Record evidence: that clicks land in the right file at
  the right scroll position, unresolved styling is visible, raw mode
  reveals source, and creating an unresolved target updates the style
  without a reload. The native Tauri window can't be browser-driven —
  this is hands-on. If a surface can't be verified, say so explicitly.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks all passed; branch
  `l3-session-b-wikilink-live-preview` created from `main`.
- [ ] Plan written at `docs/superpowers/plans/<date>-l3-session-b-wikilink-live-preview.md`.
- [ ] Every wiki-link shape decorates off-cursor and reveals raw
  on-cursor.
- [ ] Unresolved links carry the warning style; the cache invalidates
  on `vault:file-changed`.
- [ ] Click on resolved → opens target (with anchor scroll for
  headings).
- [ ] Click on unresolved → offers create at the resolved-by-convention
  path; post-create navigation works.
- [ ] Raw-source toggle still reveals literal source for wiki-link
  spans (regression test).
- [ ] §9.2 filled with what was built (Session A voice).
- [ ] CLAUDE.md "Project state" rewritten to Sessions A + B done.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`,
  `vitest`, `clippy`, `fmt`.
- [ ] Interactive smoke recorded.

---

## OUT OF SCOPE (do not build in this session)

- The backlinks panel or the right-sidebar shell (Session C).
- Tags, virtual tag pages, autocomplete (Sessions D–F).
- Block references, embeds proper, unlinked mentions (Sessions G–I).
- Pending Rewrites Cache (Session J).
- Per-inline byte spans on the canonical AST — Session B's navigation
  uses the editor's own cursor mapping for click targets and the
  `resolve_link` IPC for paths. The canonical AST stays inline-span-free.
- The L3 closeout tag (`l3`) — that's Session K.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits (matching Session A's
   shape — `feat(editor): …`, `feat(ipc): …`, `test(editor): …`,
   `docs: L3 Session B complete — …`). Do NOT skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Default per project
   workflow: merge `l3-session-b-wikilink-live-preview` into `main`
   after verifying green, `--no-ff`.
3. Report back: every DoD box's status, any decisions deferred to the
   plan, the new test counts, the smoke evidence, and name the next
   session — L3 Session C (Backlinks panel + right-sidebar shell).
