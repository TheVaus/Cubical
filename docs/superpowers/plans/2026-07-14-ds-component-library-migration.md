# Plan — Design System as the app's component library (Phase B/C/D)

**Branch:** `feat/design-system-migration`
**Goal:** The app (`ui/`) borrows every UI component from the design system
(`design-system/`), so editing a component (or token) there changes it
everywhere in the app.

## Foundation (DONE — committed)
- `44b0451` — app reskinned to Machinist/Graphite via token values.
- `1fa3188` — `@ds` Vite alias → `../design-system/src` + `dedupe:["solid-js"]`
  (single Solid instance; proven: a DS Button's onClick updated an app signal).
  `server.fs.allow` = repo root. tsconfig `@ds/*` path.
- `587dbd4` — palette single source of truth: `ui/src/styles/tokens.css` now
  `@import`s the canonical `design-system/src/styles/tokens.css` (a superset that
  also defines app-compat tokens). Proven: editing `--c-accent` there changes the
  app via HMR.
- `ab2df3a` — DS components pass the app's strict tsc: tsconfig pins
  `solid-js`/`solid-js/*` to the app's copy; 6 DS files use `import type { JSX }`.
  Verified: `ui tsc` clean with every DS primitive imported.

## Import convention
`import Button from "@ds/components/forms/Button/Button";` (default exports,
one folder per component, each imports its own co-located `.css`).

## CSS-collision strategy
DS components use generic global classes. Scan result: only **`.modal`** collides
with the app's `layout.css` (3 rules). Rule: when an app element is migrated to a
DS component, **delete the app's now-dead `layout.css` rules for it** (this also
shrinks `layout.css`, the Phase-D goal). Only if a DS class collides with a
DIFFERENT still-live app rule do we rename/scope the DS class.

## DS component prop-surface gaps
DS components are presentational and may lack props the app needs (e.g. DS Button
only has `primary|secondary` — the app may need `ghost`; DS IconButton has
`label/active/disabled/onClick`). When a gap appears, **extend the DS component in
`design-system/`** (benefits every consumer) rather than working around it in the
app. Record each extension in the ledger.

## Work-list (inline elements to migrate) — 76 buttons + 16 inputs, 19 files
- **App.tsx** — 45 buttons + 3 inputs (topbar glyphs, sidebar toggles, empty-vault
  CTAs, dialogs). BIG — split into sub-slices (topbar, empty-vault, dialogs).
- **Properties.tsx (6b/1i) + properties/* cells** (BooleanCell, ChipList,
  CurrencyCell, DateCell 5i, EnumCell, NumberCell, RawCell, StringCell) — a
  specialized inline-editing cluster; map inputs→TextInput where clean, leave
  bespoke cells that don't fit.
- **sidebar/** SearchPanel (6b/1i → IconButton + TextInput), UnlinkedMentions (1b).
- **statusbar/PendingRewrites.tsx** (3b).
- **settings/ShortcutsPanel.tsx** (2b).
- **omnibar/OmniBar.tsx** (1 input → the DS CommandPalette pattern, C-phase).
- Leaf: RecentVaultList (2b), TagPage (2b), Toast (1b → DS Toast/IconButton),
  VaultSwitcher (1b).

## Phases
- **B — leaf primitives** (this campaign's bulk): per feature-area subagent tasks.
  Each: replace inline `<button>/<input>` with `@ds` Button/IconButton/TextInput/
  Toggle/SegmentedControl/Badge/Callout/Tag/Tooltip; extend DS components as
  needed; delete dead `layout.css`; verify render in the browser; report.
- **C — behavioral wrappers**: editor, file tree, statusbar segments, omnibar/
  command palette wrap DS presentational pieces (they carry logic DS mockups lack).
- **D — cleanup**: gut remaining `layout.css`; full `cargo tauri dev` verify vs a
  real vault; run `scripts/check.sh`.

## Per-task contract (subagents)
SolidJS idioms; import from `@ds`; no raw hex/px (tokens only); verify by
rendering the app (`npm run dev`, browser) — no component test harness. tsc + build
must stay clean. Commit per area. Report DS extensions made + dead CSS removed.

## Order (B)
Start small/contained to prove the full pattern, then fan out:
1. statusbar/PendingRewrites + Toast + RecentVaultList + VaultSwitcher (leaf proof)
2. sidebar/SearchPanel + UnlinkedMentions
3. settings/ShortcutsPanel + TagPage
4. App.tsx topbar glyphs
5. App.tsx empty-vault + dialogs
6. Properties cluster
Then C, then D.
