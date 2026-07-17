# Design System as the app's component library — progress / handoff (2026-07-17)

Making [`design-system/`](../../design-system/) the single source of truth for the
app's **tokens AND components**: `ui/` borrows every component from there, so
editing a component (or a token) changes it everywhere in the app.

**Status: Phase B complete + all three Phase-D deltas settled (the last, BooleanCell, now FIXED
& live-verified). Phases C and D remain. Branch `feat/design-system-migration` is UNMERGED.**
`scripts/check.sh` is green (tsc · vitest 728 · build · cargo fmt/clippy/test · docs) — the one
red line is the documented `dropping_handle_stops_event_delivery_within_100ms` watcher flake
(passes 3/3 in isolation; zero Rust touched this session).

**Next session, start here:** the spot-check is fully closed — the BooleanCell Toggle
visible-label slot fix landed and was driven live (clicking the `true/false` text now flips the
value both ways and writes to disk; vault restored byte-for-byte). The real remaining work is
**Phase C** (behavioral wrappers, the harder half) and the **Phase D `layout.css` gut**.
~55% of the campaign done by effort. For driving the live app under `cargo tauri dev` (occlusion,
WKWebView keyboard quirks, coordinate math), read the `project-tauri-live-verify-setup`
auto-memory before re-deriving it — the compiled CGEvent `driver` binary technique still works.

Plans: [`plans/2026-07-14-ds-component-library-migration.md`](plans/2026-07-14-ds-component-library-migration.md)
(campaign: phases B/C/D + work-list) and
[`plans/2026-07-16-ds-b6-properties-cluster.md`](plans/2026-07-16-ds-b6-properties-cluster.md)
(B6 tasks + the binding global constraints).

## How much is done

~65% of the *elements* (31 bespoke `<button>`/`<input>` remain in `ui/src` vs 49
`@ds` call sites; the plan scoped Phase B at 92). But nearer **50–55% of the
campaign**: Phase B was the bulk *by count*, Phase C is the harder half *by
difficulty*, and `layout.css` — the file Phase D exists to gut — is still 679
lines (down only from 748; the bulk is layout, not controls).

## Foundation (done, was already green before B)
- `@ds/*` Vite alias → `../design-system/src`, `dedupe:["solid-js"]` (single Solid
  instance — proven: a DS Button's `onClick` updates an app signal). tsconfig
  pins `solid-js`/`solid-js/*` to the app's copy so DS files pass the app's
  strict tsc.
- Palette single-source: `ui/src/styles/tokens.css` just `@import`s the canonical
  `design-system/src/styles/tokens.css` (a superset that also carries app-compat
  names like `--c-accent-hover`, `--editor-*`).

## The load-bearing rule: DS components must be self-contained
DS components silently depended on two stylesheets **only the DS playground
loads** — the `button` reset in `design-system/src/styles/base.css` and the
`.row`/`.stack`/`.scroll-y`/`.divided-list` utilities in its `layout.css`. The app
imports neither, so every IconButton shipped in B1–B3 rendered with a UA
`2px outset` border until `10bb05b` fixed it.

**Rule: a new DS component may not depend on those globals** — set the control
reset and display/flex in the component's own CSS. (Importing the DS globals into
the app is the wrong fix twice over: its `button` reset would hit every
not-yet-migrated inline button at once, and its `.app-shell` collides with the
app's.) The utilities stay in the DS `layout.css` — the DS's own screens use them.

## Phase B — complete
| Slice | Commit | What |
|---|---|---|
| B1 leaf | `daa45f9` | PendingRewrites / RecentVaultList / VaultSwitcher / Toast |
| B2 sidebar | `a83c8a9` | SearchPanel + UnlinkedMentions |
| B3 | `bec9a55` | ShortcutsPanel + TagPage |
| B4 topbar | `7238b97` | App.tsx topbar's 5 glyphs → IconButton |
| B5 | `1b702aa` | empty-vault CTA + dialog buttons; killed the `.chrome-btn` family |
| B5b | `f14229f` | all 10 settings seg-controls → SegmentedControl `pill`; killed `.seg-control` (App.tsx −169 lines) |
| B6 | `0e4f9e9`…`96a15c7` | Properties cluster (4 subagent tasks, each reviewed); killed `miniButtonStyle` |
| final review fixes | `3ded643` | see below |

`.chrome-btn`, `.seg-control` and `miniButtonStyle` are **fully gone**.

### DS extensions made (the campaign's core pattern)
**Extend the DS additively; never work around a gap in the app.** Every addition
is optional and defaults to prior behavior:
- **Button** — `ghost`/`size`/`fullWidth`/`block`/aria (B1); `danger` +
  `--c-error-contrast` in all 3 themes (B5); `style`/`title` (B6).
- **IconButton** — `ariaPressed`/`mono` (B4); `size`/`style`/`ariaHaspopup` (B6).
- **TextInput** — `ref`/`ariaLabel`/`style` (B2); `onFocus`/`onBlur`/`onKeyDown`/
  `inputMode`/`size` (B6). Note `onInput` hands you the **value string**, not an
  event; and `onKeyDown` gets a plain DOM `KeyboardEvent` whose `currentTarget`
  is `EventTarget | null`, so `e.currentTarget.blur()` will not type-check —
  capture the element via `ref` and call `input.blur()`.
- **SegmentedControl** — `pill` variant (B5b); `role?: 'tablist' | 'radiogroup'`
  (B6 fix).
- **Toggle** — `showLabel?: boolean` (2026-07-17). When set, the switch's `label`
  renders as visible text sharing the button's hit area, so clicking the text
  toggles too. Defaults false → prior lone-`<button>` render (Gallery unchanged).
  Visible text = `label`, so label-in-name holds with no new ARIA. Restored the
  BooleanCell whole-control click that the DS-migration split had broken.
- App composes a thin local `OnOffControl` over SegmentedControl for boolean
  settings.

### What the final whole-branch review caught (both fixed in `3ded643`)
1. **B1 bit-rot.** `PendingRewrites` was migrated *before* `size="sm"` existed, so
   its 3 Buttons sat at the 32px/14px default inside a 30.4px/12px `.statusbar`.
   Per-task reviews couldn't see it — each only saw its own diff. **When a DS prop
   is added mid-campaign, sweep the slices that predate it.**
2. **Wrong ARIA.** The `pill` variant inherited SegmentedControl's hardcoded
   `role="tablist"`, so 10 Off/On settings announced as tabs and promised the APG
   arrow-key pattern the component never implemented. Fixed with the additive
   `role` prop; roving-tabindex deliberately NOT added (out of scope).

## Deliberately bespoke — each evidenced; read why before "fixing"
- **"Open as raw" text links** (`RawCell.tsx`, `Properties.tsx`) — DS ghost Button
  computes to a padded, non-underlined, hover-plated button; the target is a
  zero-padding accent underlined link. Real answer: a DS `Link`/`TextButton`.
- **ChipList's chips** — DS `Tag` hardcodes a `#` prefix, has no remove
  affordance, and is ONE button where each chip needs 2–3 controls. Forcing it
  would split one pill into two. **Consequence: DS `Tag` has zero app consumers**
  (Gallery showcase only).
- **Every `<select>`** (EnumCell, settings date-format + currency) and DateCell's
  2 native pickers — no DS `Select` exists. `inputStyle` in
  `ui/src/properties/styles.ts` survives *only* to style these.

## Accepted deltas — LIVE-VERIFIED 2026-07-17 under `cargo tauri dev`
Settled against the real `feature-test-vault` (`concepts/Properties.md` exercises
all three) by driving the app with synthetic input — see the technique + full log
in the `[[project-tauri-live-verify-setup]]` memory. Outcomes:
- **BooleanCell whole-control click — FIXED & live-verified 2026-07-17.** Was: clicking the
  `true/false` label did nothing; only the ~35×17pt Toggle track was clickable. Root cause:
  DS Toggle renders its own `role="switch"` button and can't wrap the sibling `<span>`.
  Fix (the campaign way): additive **Toggle `showLabel` slot** in `design-system/` — the label
  now shares the button's hit area; BooleanCell dropped its inert sibling span. Live proof under
  `cargo tauri dev`: clicking the `true/false` **text** flipped `done` false→true→false on disk
  (md5 changed each flip, returned to the exact original), toggling in both directions. Closed.
- **ChipList reflow — PASS (no bug).** Live: chips wrap cleanly to new rows (verified
  with 5 chips at a clean wide width); `+add` follows. The chip-edit box `7rem` →
  `width:auto` fix holds. ⚠ An apparent "chips clip instead of wrap" at a narrow (~1000px)
  window is an artifact of the editor pane being squeezed/overlapped by the fixed
  sidebar at small widths — NOT a ChipList bug; do not chase it as one.
- **PendingRewrites bar fit — PASS.** Live: "N pending changes" renders inline **on the
  left** (after the vault path, not the right), same mono baseline, no clip; the `size="sm"`
  fix fits. Popover's "Save all pending changes" (sm fullWidth) + "Undo" (sm) DS buttons
  also fit. (Note: the flush interval is 300s — `pending_rewrites.flush_interval_secs` —
  but flushed within ~60s in practice, so capture the bar promptly after an in-app rename.)
- Mini-glyphs darkened one step (`--c-fg-secondary` vs the old `--c-fg-muted`) —
  the DS value is correct; recorded, not a bug.

## Verification limitation (historical — now resolved for the three deltas)
**The vite dev preview has no Tauri backend**: `invoke` never resolves, the app
sits in `booting`, and vault-gated UI (Properties, dialogs, the editor stage)
**cannot be rendered live** there. The topbar renders regardless (verified live in B4).
The pre-spot-check technique: render the exact class combos a component emits
against the app's loaded CSS at `localhost:5173` and read computed styles — proves
tokens/variants, not interaction. **The three deltas above were fully verified live
2026-07-17 under `cargo tauri dev`** (real backend + vault); remaining vault-gated UI
in Phase C/D can be verified the same way — see `[[project-tauri-live-verify-setup]]`.

## Next — Phase C, then D
- **C — behavioral wrappers** (the harder half, ~2,600 lines untouched):
  `Editor.tsx`, `OmniBar.tsx` (→ the DS CommandPalette pattern), `Backlinks.tsx`,
  the file tree, statusbar segments; plus dialog *shells* → DS `Modal` and the
  App.tsx context menu → DS `Menu`. These carry positioning/lifecycle logic the DS
  mockups lack — that's why they were held back from B.
- **D — cleanup:** gut the remaining 679-line `layout.css`, `scripts/check.sh`. All three
  deltas are now settled (BooleanCell fixed 2026-07-17) — no open UI items from the spot-check.
  Re-run a live pass after the `layout.css` gut to catch any layout regressions.
- Also open: App.tsx's `set-info-btn` ⓘ (1.25rem — IconButton `size="sm"` now
  exists, so recheck the fit) and the tree-header `＋`/`🗀` glyphs.

## Gotchas
- **Flaky test, not yours:** `cubical-core`'s
  `watcher::tests::dropping_handle_stops_event_delivery_within_100ms` fails under
  full-workspace load (measured 870ms vs a 100ms budget) and passes 3/3 in
  isolation. It flaked across multiple sessions here; zero Rust was touched.
- These are **Solid** components: never destructure props (breaks reactivity).
- **The Properties draft/focus-guard is load-bearing.** Cells keep a local `draft`
  and ignore incoming `value` while focused, so an AST-tick refresh can't clobber
  an in-progress edit. `createEffect(on(() => props.value, …))` must track **only**
  `props.value` — adding `focused()` reintroduces a fixed bug. See the B6 plan's
  Global Constraints.
- The subagent ledger `.superpowers/sdd/progress.md` is **gitignored scratch** —
  this doc is the durable record.
