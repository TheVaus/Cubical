# Phase C slice — file-tree context menu → DS `Menu` (panel-only)

First Phase-C slice of the DS component-library migration. Campaign context and the
binding rules live in the handoff
[`2026-07-17-ds-migration-progress.md`](../2026-07-17-ds-migration-progress.md); read it
first. This doc is spec + plan for the one slice.

## Goal

Replace the hand-rolled floating context menu in `ui/src/App.tsx` with the DS `Menu`
component, so the file-tree menu is borrowed from `design-system/` like every other
migrated control. **Panel-only boundary:** the DS owns the menu panel + item semantics;
the app keeps positioning (`x/y`) and the scrim / outside-click dismiss (app lifecycle).

## Current state

- Menu markup: [`App.tsx:3066-3155`](../../../ui/src/App.tsx) — a `<Show when={contextMenu()}>`
  rendering a transparent full-screen scrim (dismiss on click / right-click) plus a
  `position: fixed` `<div role="menu">` at `(menu().x, menu().y)`, containing four inline
  `<button role="menuitem" style={contextMenuItemStyle}>` items shown conditionally by
  `kind`:
  - `kind !== "file"` → **New File**, **New Folder**
  - `kind !== "empty"` → **Rename…**, **Delete…** (Delete styled `color: var(--c-error)`)
- Bespoke style const: `contextMenuItemStyle` ([`App.tsx:163`](../../../ui/src/App.tsx)).
- DS `Menu` ([`design-system/src/components/overlay/Menu/Menu.tsx`](../../../design-system/src/components/overlay/Menu/Menu.tsx))
  already exists, is self-contained (own control reset), and takes
  `items: MenuItem[]` where `MenuItem = { id, label, shortcut?, disabled?, onSelect }`.
  It renders `<div class="menu" role="menu">` with `<button class="menu-item">` rows.
  It has **no danger/error item variant** — the one gap.

## Changes

### 1. DS extension (additive, defaults to prior behavior)
- `MenuItem` gains `danger?: boolean`.
- `Menu.tsx`: `classList={{ danger: item.danger }}` on the item button.
- `Menu.css`: `.menu-item.danger { color: var(--c-error); }` (and keep the hover legible).
- Undefined → normal color, so Gallery and any future consumer are unaffected. Mirrors the
  existing Button `danger` prop — same campaign pattern.

### 2. App migration (`App.tsx`)
- Keep the scrim `<div>` and wrap `<Menu>` in a `position: fixed; top/left` div at `(x, y)`
  — positioning stays app-owned (panel-only boundary). No `style`/`class` prop is added to
  the DS Menu; the wrapper carries position.
- Replace the inner `<div role="menu">` + four inline buttons with `<Menu items={items()} />`.
- Build `items` from `menu().kind`, preserving today's conditional set and each handler's
  existing `setContextMenu(null)` + call (`handleContextMenuNewFile` / `…NewFolder` /
  `setRenamingPath` / `handleRequestDelete`). Delete carries `danger: true`.
- Delete the now-unused `contextMenuItemStyle` const — another bespoke style block gone,
  consistent with the campaign killing `.chrome-btn` / `.seg-control` / `miniButtonStyle`.

### 3. Gallery
- No change required (Menu already showcased); optionally add a `danger` item to the demo.

## Accepted visual deltas (DS value is canonical — verify live)
- Panel bg `--c-bg-secondary` (was `--c-bg-primary` inline).
- `min-width` 200px (was `10rem` / 160px).
- Items become 28px flex rows with `--radius-sm` hover plate (was block padding, no hover).

Same "DS value wins" family as the mini-glyph darkening recorded in the handoff.

## Verification
- **Live** under `cargo tauri dev` against `feature-test-vault` (technique in the
  `project-tauri-live-verify-setup` memory):
  - Right-click a **file** row → **Rename…** + **Delete…** (Delete red); other items absent.
  - Right-click **empty** tree area → **New File** + **New Folder**.
  - Right-click a **folder** → all four.
  - Invoke **Rename…** → inline rename input appears (no disk change unless committed).
  - **Escape** and **outside-click** both dismiss.
  - Restore the vault to its original state (no files created/renamed/deleted left behind).
- **Gate:** full `scripts/check.sh` green (modulo the documented watcher flake).

## Out of scope
- Dialog shells → DS `Modal` (the other Phase-C slice; deferred — carries the `.modal` CSS
  collision + several dialogs).
- Positioning/dismiss moving into the DS (rejected: panel-only boundary chosen).
- Keyboard arrow-navigation of the menu — the app's menu never had it; not a regression.
