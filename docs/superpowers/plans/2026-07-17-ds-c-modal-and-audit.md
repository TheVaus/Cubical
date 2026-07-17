# Phase C slice C2 — delete-confirm dialog → DS `Modal` + a Phase-C fit audit

Second Phase-C slice, plus the audit that scoped it. Campaign context + binding
rules: the handoff [`2026-07-17-ds-migration-progress.md`](../2026-07-17-ds-migration-progress.md).

## Phase-C fit audit (why most remaining surfaces are NOT clean swaps)

Surveyed every overlay/dialog surface in `ui/src` against the DS components that
exist. The DS-backed slices divide sharply:

| Surface | Location | DS target | Verdict |
|---|---|---|---|
| File-tree context menu | `App.tsx` | `Menu` | ✅ done (C1) |
| **Delete-confirm dialog** | `App.tsx` | `Modal` | **C2 (this doc)** — needs additive `Modal` size/placement/ARIA |
| Settings modal | `App.tsx` (`.modal` 40rem×28rem) | `Modal` | **Bespoke** — two-pane (nav 11rem + body); DS `Modal` is single-column/title-bar. Shell-only migration is marginal; leave until a dedicated pass |
| OmniBar | `omnibar/OmniBar.tsx` | `CommandPalette` | **Bespoke** — ranked multi-kind palette (fuzzy `rankItems`, matched-char `<mark>`ing, note/tag/command kinds w/ distinct activation, recency fallback, kind badges, subtitles). DS `CommandPalette` is a flat `{id,label,onRun}` list; a swap would regress all of that. Same class as ChipList-vs-`Tag` |
| VaultSwitcher / PendingRewrites / set-info popovers | resp. files | (none) | **Bespoke** — positioned dropdowns/popovers; no DS `Popover` exists |

Non-overlay Phase-C "wrappers" (`Editor.tsx`, `Backlinks.tsx`, statusbar segments,
file-tree rows) are app-specific compositions, not single-DS-component swaps; their
migratable content is inline **primitives** (`Button`/`IconButton`/`TextInput`),
which is the Phase-D/inline-control sweep, not an overlay slice.

**Conclusion:** after C2, the DS-component-backed overlay migrations are exhausted.
What's left in C is genuinely-bespoke overlays (documented above, don't "fix"
without reading why) + the inline-primitive sweep + the Phase-D `layout.css` gut.

## C2 — delete-confirm dialog → DS `Modal`

### Problem
The DS `Modal` was built for large content modals (fixed **560px**, **top-anchored**,
title-bar, no body padding) and had **zero app consumers**. The app's only compact
dialog — the delete-confirm ([`App.tsx`](../../../ui/src/App.tsx), `deleteTarget`) — is
a **min(24rem,90vw) centered** confirm. A naive swap would widen it to 560px, move it
up, and (worse) drop its `role="dialog"`/`aria-modal`/accessible-name, since the DS
`Modal` panel carried **no dialog ARIA at all**.

### Changes
1. **DS `Modal` — additive (defaults = prior behavior):**
   - **Dialog ARIA (always on — a modal *is* a dialog):** `.modal-panel` gets
     `role="dialog"` + `aria-modal="true"`; accessible name via `aria-labelledby` to
     the title when `title` is set, else a new `ariaLabel?` prop.
   - **`size?: 'sm' | 'md'`** — `md` (default) = 560px; `sm` = `min(24rem,90vw)`.
   - **`placement?: 'top' | 'center'`** — `top` (default) = current 15vh offset;
     `center` centers vertically.
2. **App:** replace the delete-confirm's inline `.modal-backdrop` + panel with
   `<Modal open size="sm" placement="center" ariaLabel="Confirm delete" onClose=…>`.
   `onClose` keeps the `deleteInFlight` guard (blocks Escape/scrim-close mid-delete).
   Content (message + Cancel/Delete `Button`s) stays as the app's padded child. The
   `.modal-backdrop` CSS stays — the Settings modal still uses it (Phase-D concern).
3. **Gallery:** add a `sm`/`center` confirm demo beside the existing content modal.

### Verification
- **Live** under `cargo tauri dev`: right-click a file → **Delete…** → confirm dialog
  is compact + centered, message correct; **Cancel** (and Escape / scrim-click)
  dismiss without deleting. Do **not** confirm a real delete; leave the vault intact.
- **Gate:** full `scripts/check.sh` green.

### Out of scope
- Settings modal, OmniBar, popovers (all bespoke per the audit above).
- Removing `.modal*` from `layout.css` — Phase D, after the Settings modal is dealt with.
