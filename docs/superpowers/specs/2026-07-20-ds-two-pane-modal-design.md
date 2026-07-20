# DS two-pane Modal primitive — design (2026-07-20)

Net-new design-system primitive for issue **#35**: a two-pane (nav + body) modal
that unblocks the app's bespoke **Settings modal**. Sixth of the seven #35
primitives; leaves only the richer OmniBar `CommandPalette`.

This is **net-new DS authoring, not cleanup**: build the primitive in
`design-system/`, then adopt it in `ui/` (the campaign pattern — see the migration
handoff [`../2026-07-17-ds-migration-progress.md`](../2026-07-17-ds-migration-progress.md)).

## Problem

The Settings modal (`ui/src/App.tsx` ~2479–2534 shell) is a hand-rolled two-pane
overlay: a left nav (title + icon/label tabs with an active state) and a scrollable
right body. DS `Modal` is single-column with a title bar, so the Settings shell was
left **deliberately bespoke** (recorded in the handoff's bespoke list and issue #35).
Its `.modal-backdrop` / `.modal` / `.modal__*` rules are the "deliberately-kept" set
in `ui/src/styles/layout.css` (lines ~438–513). The current markup also carries an
**ARIA bug**: `role="dialog"` / `aria-modal` sit on the `.modal-backdrop` scrim
instead of the panel.

## Boundary — what moves vs. stays

**Moves into the DS component** (the two-pane *shell chrome*):
- the scrim (`.modal-backdrop`), the 40rem×28rem panel (`.modal`), the positioned
  close button (`.modal__close`);
- the left nav: title (`.modal__navtitle`) + icon/label items (`.modal__navitem`,
  `:hover`, `--active`);
- the scrollable body **container** (`.modal__body`).

**Stays app-owned** (everything *inside* the body slot — the settings content):
- `.set-row*`, `.set-row__lab/__desc/__control`;
- the `.set-info-btn` ⓘ / `.set-info-pop` info affordance (already on DS `Popover`
  per #35);
- two selectors that today piggyback on the `.modal` ancestor and must be **renamed**
  to settings-owned classes because `.modal` becomes DS-internal:
  - `.modal__h2` (section heading in the body) → e.g. `.set-h2`;
  - `.modal kbd` (shortcuts tab) → e.g. `.set-body kbd` (scoped to a class the app
    still owns on/around the body content).

## Approach

**Chosen: A — standalone `TwoPaneModal`.** A new component in
`design-system/src/components/overlay/TwoPaneModal/` that renders its own overlay
shell (Portal + scrim + Escape + click-outside-to-close + `role="dialog"` panel) plus
the two-pane grid, nav, and close button. It duplicates ~15 lines of scrim/Escape/
portal mechanics that `Modal` also has.

Rejected alternatives:
- **B — compose the existing `Modal`.** Would need additive Modal props to drop its
  fixed width/padding/title so the child owns the panel interior — props that serve
  *only* two-pane (panel-override smell), and Modal's `md` width fights 40rem.
- **C — extract a shared internal `Overlay`** (portal+scrim+escape+ARIA) that both
  `Modal` and `TwoPaneModal` compose. SRP-ideal and removes the duplication, but
  refactors the **live** `Modal` that the delete-confirm dialog (`App.tsx:3119`, the
  only app consumer) depends on — a blast radius disproportionate to migrating one
  surface.

**Why A:** the duplicated shell is ~15 stable lines; the campaign prizes
self-containment and low blast radius; A leaves the live delete-confirm Modal
untouched. C is the correct long-term factoring but is better filed as a future
DS-internal cleanup once enough overlay users (Modal, TwoPaneModal, and the eventual
richer CommandPalette) justify refactoring a live component. Recorded here so the
follow-up isn't lost.

## DS API

`design-system/src/components/overlay/TwoPaneModal/TwoPaneModal.tsx`:

```tsx
interface TwoPaneNavItem {
  id: string;
  icon?: IconName;   // DS Icon name; optional
  label: string;
}

interface TwoPaneModalProps {
  open: boolean;
  onClose: () => void;
  title: string;                 // nav header, e.g. "Settings"
  items: TwoPaneNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel?: string;            // panel accessible name; defaults to `title`
  children: JSX.Element;         // body for the active pane (app-owned content)
}
```

Structured-nav (the DS owns nav rendering + active state), chosen over a bare
two-slot frame so the `.modal__nav*` chrome fully lives in the DS and the app call
site stays small. `IconName` comes from the DS Icon registry, so nav icons need no
app wiring.

**Behavior / locked DS rules:**
- Self-contained: the component sets its own control reset and layout in its own CSS;
  it must **not** depend on the playground's `base.css`/`layout.css` globals (the
  campaign's load-bearing self-containment rule).
- Solid: never destructure props.
- `role="dialog"` + `aria-modal="true"` on the **panel** (fixes the current bug);
  `aria-label` = `ariaLabel ?? title`.
- Escape and scrim/backdrop click both call `onClose`; body click does not propagate.
- Nav items render as `<button type="button">`s; the active item carries the
  `--active` styling and `aria-current="true"` so it is announced. (Full APG tablist
  semantics — `role="tablist"` + roving tabindex — are deliberately **out of scope**,
  the same call made for SegmentedControl's `pill` variant in the campaign.)
- Close button uses DS `IconButton` + `close` Icon (matches today's markup).

## App adoption

- Replace `App.tsx` ~2479–2534 (the `.modal-backdrop` → `.modal__nav` shell + the
  `<For>` nav loop) with a single `<TwoPaneModal open={settingsOpen()}
  onClose={…} title="Settings" items={SETTINGS_TABS} activeId={settingsTab()}
  onSelect={(id) => { setSettingsTab(id as SettingsTab); setOpenInfo(null); }}>`.
  The existing per-tab body `<Show>` blocks become the `children`.
- `onClose` keeps the current dual reset (`setSettingsOpen(false); setOpenInfo(null)`).
- Move `.modal-backdrop`/`.modal`/`.modal__close`/`.modal__nav*`/`.modal__body` out
  of `ui/src/styles/layout.css` into `TwoPaneModal.css`. Rename `.modal__h2` and
  `.modal kbd` to settings-owned classes and update their call sites in the body.
- Verify no other `.modal*` consumer remains in `ui/` after the move (the DS `Modal`
  uses `.modal-scrim`/`.modal-panel`, a different namespace, so no collision).

## Testing & verification

- **DS unit test** (`ui/src/ds-two-pane-modal.test.tsx`, matching the `ds-*.test.tsx`
  convention): renders the nav items; the active item reflects `activeId`; clicking a
  nav item fires `onSelect` with its id; Escape and scrim click fire `onClose` while a
  body click does not; `role="dialog"` is on the panel with the expected accessible
  name.
- `scripts/check.sh` green (tsc for both `ui` and `design-system`, vitest, build,
  cargo fmt/clippy/test, docs) — modulo the known watcher flake.
- **Live-verify under `cargo tauri dev`** (see `[[project-tauri-live-verify-setup]]`):
  Settings opens, all seven tabs switch and show the right pane, Escape/scrim close it,
  and the untouched delete-confirm `Modal` still renders/closes correctly.

## Out of scope

- The richer OmniBar `CommandPalette` (the last #35 primitive) — separate session.
- Refactoring `Modal` onto a shared `Overlay` (approach C) — future DS-internal
  cleanup, noted above.
- Any change to the settings *content* beyond the two class renames.

## Durable-doc updates at close

- `docs/architecture/ui.md` §11.6: drop the two-pane Settings modal from the
  remaining-bespoke list (OmniBar palette becomes the sole remaining bespoke surface).
- Issue #35: check the "Two-pane `Modal` variant" box with a merge note.
- CLAUDE.md project state + the #35 memory: 6 of 7 primitives merged.
