# Kickoff — Embed re-render scroll-jump fix (own-write invalidation)

> Copy the body below (everything under the horizontal rule) into a
> fresh Cubical session as the opening message. Short, focused bug-fix
> session. It is gated **before L4-B** per `docs/layer-4-spec.md` §9.2.

---

Start a focused bug-fix session: **fix the embed re-render scroll-jump
on autosave.** This is the one known issue left open by the `l4a-fix`
session. It is small and already diagnosed — but it touches the
watcher → resolver → autosave interaction, so treat it with care, TDD
it where the logic is testable, and run an executed interactive smoke
before tagging (the `docs/conventions.md` §Sessions ritual now requires
it).

## State of the project

`l4a-fix` closed 2026-06-06 (`l4a-fix` tag, commit `fe9a8b8`, on
`main`, pushed). It fixed the embed Live-Preview surface: render
(whole-line block replace for own-line embeds), cursor traversal
(`atomicRanges` + `ui/src/editor/embedNav.ts` vertical-motion keymap),
and the nested-embed "Loading…" freeze (`EmbedResolver.version()`
folded into widget identity). Full writeup in `docs/layer-4-spec.md`
§9.2 and the design spec `docs/superpowers/specs/2026-06-04-l4a-fix-design.md`.

All CLAUDE.md non-negotiables apply and none should be relaxed: plain
`.md` is the source of truth, vault is portable, no UUID injection
before L7, desktop-only v1, WASI/WASM plugins.

## The bug

**Symptom (operator-reported during `l4a-fix` smoke):** while typing
in a markdown file that contains a rendered embed (`![[X]]` on its own
line, shown as a card), the editor **viewport occasionally jumps to
the top** of the document. The **text cursor stays in place** — so
this is a scroll/anchor jump, not a cursor bug. It is intermittent and
tracks the autosave cadence (~300 ms debounce).

**Root cause (already traced — confirm before fixing):** in
`ui/src/App.tsx`, the `onVaultFileChanged` handler (≈ lines 758–801)
calls `embedResolver()?.invalidate()` **unconditionally** near the top
(≈ line 770), *before* the own-write suppression check (≈ line 801:
`if (incoming === lastWrittenHash) return;`, which today only guards
the conflict-banner logic).

Sequence: you type → autosave writes the open file → the OS file
watcher reports that **own write** back as a `vault:file-changed`
event → the unconditional `invalidate()` clears the whole embed cache
and bumps `EmbedResolver.version()` (`ui/src/editor/embedResolver.ts`)
→ every rendered embed widget remounts and re-fetches, collapsing to
its `estimatedHeight` (~60 px, `ui/src/editor/embed.ts` `EmbedWidget`)
and re-expanding to full height → that height thrash above the cursor
makes CodeMirror 6 re-anchor the viewport. The adjacent
`wikilinkResolver()?.invalidate()` has the same unconditional shape but
is far less visible (wiki-link decorations don't thrash height).

Pre-existing (the unconditional invalidate is L3 Session H.2); the
`l4a-fix` block-card rendering + `version()`-driven remount amplified
its visibility.

## Fix options (brainstorm picks one)

1. **Skip invalidation on own writes.** Restructure the handler so the
   open file's own autosave echo does **not** invalidate, while changes
   to *other* files (and genuine *external* edits to the open file)
   still do. Note the current control flow already early-`return`s for
   the non-open-file and no-hash cases *after* the invalidate calls, so
   you can't just move the invalidate below the existing `return`s
   wholesale — a different file changing genuinely should still
   invalidate. The shape you want: invalidate for other files' changes
   always; for the open file, invalidate only when
   `incoming !== lastWrittenHash` (real external edit, not an autosave
   echo). Smallest change; likely sufficient.
2. **Scope invalidation to the changed target.** Add a targeted
   `invalidate(path)` to the resolver that drops only cache entries
   resolving to the changed file, so unrelated embeds never remount.
   Larger (resolver API change) but more precise — and it also reduces
   needless remounts when *other* files change. Consider if option 1
   feels too coarse.

The brainstorm should pick 1 or 2 (or a hybrid) deliberately, then
`superpowers:writing-plans`.

## What's genuinely unknown (verify, don't assume)

- **Whether the height thrash is the *only* contributor.** The trace
  is well-grounded, but confirm in the running app: reproduce the jump,
  then confirm that suppressing the own-write invalidate eliminates it.
  If a jump persists, instrument (a dev-only update listener logging
  `scrollDOM.scrollTop` + the embed remount events) before adding more
  fixes — same discipline that cracked the cursor bug last session.
- **`estimatedHeight` interaction.** If option 1 alone doesn't fully
  settle it, a secondary lever is making the embed widget preserve its
  measured height across a remount (avoid the 60 px collapse). Don't
  reach for this unless evidence shows option 1/2 is insufficient.

## Constraints (inherited)

Main checkout + branches, **no worktrees**. Short, focused session —
one surface (the watcher/resolver invalidation path). TDD where the
logic is unit-testable (the handler's own-write decision; any new
resolver method). Per-task commits. All six gates green at every
commit boundary: `cargo test --workspace`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --all --check`, and in `ui/`:
`npx tsc --noEmit`, `npm run build`, `npx vitest run`. End commit
messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Executed interactive smoke before tagging** (Contract E):
`cargo tauri dev`, open `~/Developer/sandbox/cubical-l4a-smoke/`
(A.md/B.md/C.md carry own-line embeds), type continuously in a file
with a rendered embed for ~30 s, confirm the viewport no longer jumps
while the embed stays rendered. Then confirm a genuine **external**
edit to the open file (echo from another terminal) still refreshes the
embeds. jsdom has no layout engine, so the scroll behaviour itself is
operator-smoke-only — the unit tests cover the decision logic, the
smoke covers the visible effect.

## Definition of done

- Typing in a file with a rendered embed no longer jumps the viewport.
- External edits to the open file still refresh embeds (no regression
  in the live-refresh substrate).
- Six gates green; executed smoke recorded.
- `docs/layer-4-spec.md` §9.2 "Known issue (deferred)" updated to
  "resolved" with the fix summary; CLAUDE.md "Known issue" line removed
  from Project state.
- Tag if you want a marker (e.g. `l4a-fix.1`), or just land on `main` —
  operator's call; this is a follow-up patch, not a layer transition.

## After this

**L4-B — persistent left-panel search results UI** (build-order item
4, first UI consumer of L4-A's search IPC) is unblocked once this
lands. That is its own session with its own kickoff.
