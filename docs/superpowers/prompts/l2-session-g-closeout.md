# L2 Session G — Interactive smoke + L2 closeout

L2 Session G — Interactive smoke + L2 closeout for the Cubical project.
This is the L2 closeout session. It ships **no new feature code** — it is
the hands-on verification pass and the `l2` tag. Do NOT start any L3 work.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, conventions, "Project state" block.
   - `docs/layer-2-spec.md` — especially §6 (Definition of Done — the full L2 checklist), §8 Session G, and §9.1–§9.6 (what every L2 session built). Note §9.2 (Session B) and §9.4 (Session D) are abbreviated stubs that say "Full write-up is Session G's closeout job."
   - `docs/architecture/README.md` and `docs/architecture/document-model.md` — for STEP 2 item 4 (architecture-deviation promotion).

2. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -4` → top commit is `f754477 docs: mark L2 Session F complete`, preceded by `0559e06`, `f21ddf3`, `2e2ba42`.
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0` and `l1`, does NOT contain `l2`.
   - Prerequisites: Sessions A–F all complete per the "Project state" block. If not, STOP.

3. Baseline test counts to confirm before starting:
   - `cd /Users/user/Developer/Cubical && cargo test --workspace` → 121 Rust tests green.
   - `cd ui && npx vitest run` → 99 vitest tests green.
   If either differs, STOP and report.

4. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l2-session-g-closeout`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `using-superpowers` — ALWAYS, first.
- `verification-before-completion` — ALWAYS. This whole session IS verification; every DoD checkbox needs fresh evidence before it is ticked. Evidence before assertions.
- `finishing-a-development-branch` — ALWAYS, at the very end.

SKIP `brainstorming` and `test-driven-development` — no new design, no new code. If the smoke pass uncovers a bug, invoke `systematic-debugging` before fixing it, and `test-driven-development` to land a regression test for the fix.

---

## STEP 2 — THE CLOSEOUT WORK (layer-2-spec.md §8 Session G, §6 DoD)

No new feature code. The deliverables:

1. **Interactive smoke pass against `cargo tauri dev`.** Prepare (or reuse) a test vault containing diverse `.md` files: files with and without frontmatter, a file with one of every in-scope Lezer node type (§2.2), a file whose frontmatter has comments/anchors (to exercise the Session F read-only degrade), and the six-row demo doc (`title: foo`, `tags: [a, b]`, `created: 2026-05-13`, `archived: false`, `count: 7`, `nested: { x: 1 }`). Exercise all six L2 surfaces by hand:
   - **Write + autosave** (Session A) — type, 300ms idle, confirm on-disk byte-match via SHA-256; blur flush; file-switch flush; conflict banner (Reload / Keep my edits) with the `external_edit_override` audit_log row.
   - **Live Preview decorations** (Session B) — each in-scope node decorates off-cursor-line, raw on cursor-line.
   - **Settings** (Session C) — a value round-trips and survives an app restart.
   - **Theme** (Session D) — header button cycles `system→light→dark`; OS theme change flips `system` mode without reload; CM6 colors track the UI.
   - **Raw toggle** (Session E) — naked click flips per-doc; `Cmd/Ctrl+E`; Shift-click persists the default across restart; file-switch resets the override.
   - **Properties UI** (Session F) — six-row doc renders the correct six cell types; edit each cell and confirm the on-disk frontmatter round-trips losslessly (hash or re-read); add a property to a frontmatter-less file → valid `---` block at file start; a nested/unknown value is raw read-only with a working "Open as raw"; a comments/anchors file degrades the panel to read-only; toggle raw mode, hand-edit the frontmatter text, confirm Properties rows update on the next AST tick without flicker.

   Record observed evidence — timestamps, latencies, content hashes, audit_log row IDs — as you go. Note: the native Tauri window cannot be driven by the browser-preview tools; this pass is genuinely hands-on. If a surface cannot be verified, say so explicitly rather than ticking its box.

2. **Fill `docs/layer-2-spec.md` §9.7** "Session G — Interactive smoke + L2 closeout" with the recorded smoke evidence. Also **expand the abbreviated §9.2 (Session B) and §9.4 (Session D) stubs** into full write-ups — that was explicitly deferred to this session.

3. **Tick every `docs/layer-2-spec.md` §6 Definition-of-Done checkbox** that is satisfied, with the evidence behind it. Any box that cannot be ticked is a bug — STOP, report it, and do not apply the `l2` tag until it is resolved (file it against the owning session).

4. **Architecture-deviation promotion.** `docs/layer-2-spec.md` §5 closing note says: if any L2 deviation is a load-bearing architectural call (most likely #2 — decorations bypassing the canonical AST), promote it to `docs/architecture/document-model.md` at L2 close. Review §5's five deviations and promote the load-bearing ones; record what you promoted.

5. **Rewrite (do not append to) the CLAUDE.md "Project state" block** to reflect L2 **closed**: current layer advances to 3, all L2 sessions done, final test counts, `l2` tag noted with its date, and "Next" set to the first L3 session.

6. **Apply the `l2` git tag** on the closeout commit — only after every DoD box is ticked.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:
- `cd /Users/user/Developer/Cubical && cargo test --workspace` → 121 green.
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 99 green.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check` → clean (§6 DoD lines).
- The interactive smoke pass itself — recorded in §9.7 with observed values.

This session changes only docs, so the test counts must be unchanged (121 / 99). If a smoke-pass bug forces a code fix, the fix needs a TDD regression test and the counts will rise — document why.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks all passed; branch `l2-session-g-closeout` created from `main`.
- [ ] Interactive `cargo tauri dev` smoke pass completed for all six L2 surfaces, evidence recorded.
- [ ] Every `docs/layer-2-spec.md` §6 DoD checkbox ticked with evidence (or a bug filed and the tag withheld).
- [ ] §9.7 filled; §9.2 and §9.4 expanded from stubs into full write-ups.
- [ ] Load-bearing L2 architecture deviations promoted into `docs/architecture/document-model.md`.
- [ ] CLAUDE.md "Project state" rewritten to L2 closed / L3 next.
- [ ] `cargo test --workspace` 121 green; `tsc`, `build`, `vitest` 99, `clippy`, `fmt` all clean.
- [ ] `l2` git tag applied on the closeout commit.

---

## OUT OF SCOPE (do not build)

- Any new L2 feature code. Session G is verification + closeout only.
- Any L3 work (wiki-links, embeds, backlinks, tag autocomplete/indexing).
- New tests, except a regression test mandatory for any bug the smoke pass uncovers.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits (e.g. `docs: L2 closeout — §9.7 smoke + DoD`, and a separate commit for any architecture-doc promotion). Do NOT skip hooks. Do NOT push.
2. Apply the `l2` tag on the final closeout commit.
3. Invoke `finishing-a-development-branch`. Default per project workflow: merge `l2-session-g-closeout` into `main` after verifying green.
4. Report back to the operator: smoke results, every DoD box's status, any bugs found and how resolved, the `l2` tag, and name the next session — the first L3 session (Knowledge Graph — wiki-links).
