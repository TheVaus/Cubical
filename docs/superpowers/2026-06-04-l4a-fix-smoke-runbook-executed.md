# L4-A-fix smoke runbook — EXECUTED

> Operator-executed record. Companion to the blank scaffold
> `docs/superpowers/2026-06-04-l4a-fix-smoke-runbook.md`.

**Operator:** daniel.vekar (repo owner, at the keyboard)
**Date:** 2026-06-06
**Build commit at confirmation:** `03c2048` (fix `88bd614` + spec amendment)
**Vault:** `~/Developer/sandbox/cubical-l4a-smoke/`
**Method:** Interactive `cargo tauri dev`, hands-on, across several
iterations this session (the bugs were found, fixed, and re-confirmed
in the running app — not just unit tests).

---

## Scope note (honest)

This session (`l4a-fix`) changed **only the editor surface** —
Live-Preview bundle gating, embed rendering, and the embed/wikilink
resolvers. It changed **zero** search / IPC / Rust code. The smoke
below therefore concentrates on the editor surface this session
actually touched, plus the L2/L3 editor behaviours exercised
incidentally while reproducing and confirming the bugs.

The L4-A **search** recipes (search 1–11, index status, health,
watcher fan-out) test the Tantivy backend, which is **unchanged** in
this session — they were the L4-A close's responsibility (verified
there via the `cubical-search` + handler unit suites). They were
**not** re-walked here because no code path under them changed. The
broader L1 file-watcher recipes likewise saw no code change.

---

## Section 6 — L4-A-fix targeted bug repros (the motivating bugs)

- [x] **Bug #4 (Contract 1 — Live-Preview bundle).** Open a file
  containing an embed, toggle raw-source (`Cmd-E`). Literal `![[…]]`
  text shows with **no** widget rendered over it; toggle back restores
  the widget.
  **Observation:** Operator-confirmed working ("i confirm").

- [x] **Bug #5 (Contract 4 — resolver version()).** Open `A.md`,
  `B.md`, `C.md`. Nested embeds now resolve and render instead of
  freezing on "Loading…". (`D.md` already worked — depth-1.)
  **Observation:** Operator-confirmed working ("i confirm"). Root
  cause was the nested-embed re-render gap; the `version()`-keyed
  widget identity now forces the cascade to converge.

- [x] **Bug #6 (Contract 2 — inline replace).** Open a file with an
  embed, place the cursor below it, press Up. Cursor lands on the
  correct adjacent line — not row 2, not doc start.
  **Observation:** Operator-confirmed working ("i confirm") after the
  block→inline replace correction. (This was the 3rd approach; the
  confirmation closes it without an architecture review.)

## Editor behaviours exercised incidentally (L2 / L3 surface)

- [x] **Wiki-link cross-file + heading-anchor scroll** (bug #2 probe):
  `[[Aliased Note#Heading section]]` scrolls to the heading.
  Operator: "seams to work just fine."
- [x] **Same-file self-ref wiki-link** (bug #3 probe):
  `[[notes/inbox/Stuff|self-ref via path]]` — click acknowledged,
  no-op is correct (nowhere to scroll). Operator: "seams to work
  just fine."
- [x] **Raw-source toggle** (`Cmd-E`) reveals/hides the live-preview
  layer including embeds — exercised repeatedly during the #4 repro.
- [x] **`^block-id` rendering** (bug #1): current smaller+grayer
  treatment confirmed as intended by the operator; left unchanged.
- [x] **Embed inline rendering**: embeds now render inline
  (`embeds:` then the card) rather than as a full-width block — a
  deliberate consequence of the inline-replace fix, operator-aware.

## Not walked this session (no code change → deferred to their layer)

- [ ] L4-A search recipes 1–11, index status, rebuild, health,
  watcher fan-out — Tantivy backend unchanged this session.
- [ ] L1 file-watcher external-edit recipe, L2 Properties /
  autosave / conflict-banner / theme recipes — no code change this
  session. These remain the standing backfill the new
  `docs/conventions.md` §Sessions ritual binds for the next session
  that touches their surface.

---

## Closeout

- **Pass/fail summary:** All three motivating bugs (#4, #5, #6)
  operator-confirmed fixed in the running app. Editor surface this
  session touched is verified. No regressions observed in the
  exercised behaviours.
- **Outstanding follow-ups:**
  - *Embed re-render scroll jump on autosave* (operator-reported,
    non-blocking): typing in a file with a rendered embed occasionally
    jumps the viewport to the top (cursor stays put). Root cause:
    unconditional `embedResolver().invalidate()` on the open file's own
    autosave writes → embed remount/height-thrash → viewport re-anchor.
    Documented in `docs/layer-4-spec.md` §9.2 "Known issue (deferred)".
    Recommended as a focused follow-up before L4-B.
  - The search / watcher / properties recipe sweep stays as standing
    backfill for the next session touching those surfaces (per
    Contract E).
- **Tag decision:** `l4a-fix` cleared to land — the session's own
  surface is operator-verified.
