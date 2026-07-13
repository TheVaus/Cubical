# Cubical Design System — Design Spec

Date: 2026-07-13

## Summary

Build a complete, production-grade design system for **Cubical**, a desktop,
local-first Markdown knowledge base (an Obsidian-class notes app). The deliverable
is a SolidJS component library, token system, and a set of full-screen mockups
demonstrating the system in context, plus a gallery page and README.

This is a UI/design-system shell: mock data only, no real vault/file persistence,
except the editor column which uses a real CodeMirror 6 instance.

## Tech stack

- SolidJS + Vite + TypeScript, via `vite-plugin-solid`.
- Solid idioms only: `createSignal`, `createMemo`, `<Show>`, `<For>`, props
  accessed as `props.x` (never destructured), `class` not `className`.
- No React and no React-derived dependencies anywhere in `package.json`.
- Styling: plain CSS custom properties + `.css` files, co-located with
  components. No CSS-in-JS, no Tailwind.
- Package manager: npm.
- No router library — screen switching is a signal-based view switcher (this is
  a component showcase, not a multi-route product). The command palette is a
  global overlay, not a route.
- Editor column uses real `@codemirror/*` packages (state, view, commands,
  `@codemirror/lang-markdown`), themed entirely through our CSS tokens — no
  CodeMirror default theme classes leak into the visual design.
- Mock data (vault tree, notes, frontmatter, backlinks) lives in static TS
  fixture files under `src/fixtures/`. No file I/O, no persistence layer.

## Design language — "Machinist / Graphite"

The chrome must recede so the user's own text is the loudest thing on screen.
Plain, inspectable, nothing hidden.

**The one rule:** `--c-accent` (a desaturated graphite-teal) means exactly ONE
thing — STATE: selection, active, focus, caret, resolved wiki-links/tags. Never
brand decoration. Identity is carried by the true-neutral warm surface + the
cube mark. Saturated color is rationed to STATUS only (`--c-success`,
`--c-warning`, `--c-error`).

**Color.** Warm-neutral cream paper `#faf8f3` (light) / warm near-black
`#181610` (dark) — warm neutrals, never blue-grey. Three surface steps
(primary→secondary→tertiary); tertiary is both hover and selection fill.
Whites/blacks toned, never pure — except a High-Contrast theme that IS pure.
Ship light, dark, and high-contrast themes via `[data-theme]` scopes on `<html>`.

**Type.** Native system stacks only, no webfonts/CDN. Sans for prose, mono for
machinery (file extensions, keys, token names, counts, paths, code). 7-step
ramp 12→30px. Headings weight 700, tracking -0.01em; body 400 / 1.5 leading. No
display face.

**Spacing & shape.** 4px base scale (`--space-1..8`). Radii small/machined: sm
4px, md 6px, lg 10px, plus full for pills. File-tree rows fixed 32px. Tight,
comfortable density.

**Borders.** Hairlines and alignment, not boxes. `--c-border-subtle` for
decorative dividers, `--c-border-strong` (≥3:1 contrast) for real boundaries
and secondary-button outlines. Nested outlined boxes are an anti-pattern —
become divided lists instead.

**Elevation.** Flat by default. Shadows (sm/md/lg) only on transient overlays
(menus, popovers, modals, toasts, tooltips). Nothing that scrolls or repaints
gets a shadow. Modal scrim = `rgba(0,0,0,.5)`.

**Selection signature.** Selected list item = accent rail
`box-shadow: inset 2px 0 0 var(--c-accent)` over a `--c-bg-tertiary` fill —
never an accent background.

**Motion.** `transform` + `opacity` only, never layout. 120ms for state
changes, 200ms for surfaces (sidebar slide = `translateX(±101%)` + opacity).
No springs, no filter/backdrop-filter, no long eases.
`prefers-reduced-motion: reduce` collapses all durations to 0ms.

**Hover/press/focus.** Hover = `--c-bg-tertiary` fill (glyph buttons) or
`--c-border-strong` border (chrome buttons) + `--c-fg-primary` text.
Active/toggle-on = accent fill with `--c-accent-contrast` text. Focus-visible =
2px solid `--c-focus-ring` at 2px offset, always visible, keyboard-first.

**Backgrounds & imagery.** No gradients, no photography, no illustration, no
texture. The surface IS the background. Deliberate refusal.

## Content/voice

Plain, precise, engineer-to-engineer. Short declarative sentences. No
marketing gloss, no exclamation. Imperative UI labels ("Open Vault",
"Rename…", "Reveal in file tree"). Sentence case for buttons/menus/titles;
UPPERCASE + letter-spacing (.05–.16em) only for small mono eyebrows/section
labels. Mono for all machinery. Numbers/status stated literally ("Vault
indexed — 1,204 notes."). Em-dash for consequence, middot `·` as separator,
`…` on actions that open further UI. No emoji, ever.

## Iconography

- Chrome glyphs: Unicode in the type stack (`‹ › ⟨ ⟩ ⌄ × ⚙ +`, and `</>` in
  mono), text-sm, line-height 1, 1.9rem hit target, `fg-secondary` →
  `fg-primary` on hover.
- File/folder icons: 16px line SVG, `currentColor`, stroke-width 1.3, round
  joins. Set: folder, folder-open, .md, .txt, .png, .svg, .pdf, code, canvas,
  broken.
- The mark: a cabinet-projection cube — six flat faces, `currentColor` stroke,
  stroke-width 1.6 at 24px. Never gradient, never a baked rounded-rect.
- No emoji, no icon-font, no CDN.

## Folder structure

```
cubical-design-system/
  src/
    styles/
      tokens.css        # base tokens + semantic aliases + theme scopes + reduced-motion
      base.css           # resets, element defaults
      layout.css         # shared layout primitives
    fixtures/            # mock vault tree, notes, frontmatter, backlinks
    components/
      forms/             # Button, IconButton, TextInput, Toggle, SegmentedControl
      feedback/           # Badge, Callout, Toast, Tooltip
      overlay/            # Menu, Modal, CommandPalette
      data/                # Tag, FileTreeRow, BacklinkRow
      brand/               # CubeMark
    screens/
      Workspace/          # topbar, file tree, editor column, right sidebar, status bar, minimap
      EmptyVault/
      Settings/
      Gallery/             # component states showcase
    App.tsx               # signal-based screen switcher + theme provider
  README.md                # documents tokens, components, screens, "the one rule"
```

## Component inventory (build all, no subset)

- **forms/**: Button, IconButton, TextInput, Toggle, SegmentedControl
- **feedback/**: Badge, Callout, Toast, Tooltip
- **overlay/**: Menu, Modal, CommandPalette
- **data/**: Tag, FileTreeRow, BacklinkRow
- **brand/**: CubeMark

Every component: co-located `.css`, every value token-driven (no hardcoded hex
or px), and implements the full state matrix below where applicable.

### Required states

- **Glyph button**: resting `fg-secondary`/transparent → hover
  `bg-tertiary`/`fg-primary` → active accent fill/`accent-contrast` → focus 2px
  ring.
- **File-tree row** (32px fixed height): hover `bg-tertiary`; selected
  `bg-tertiary` + accent rail; invalid = warning color + dotted underline + ⚠;
  rename = inline input with accent border.
- **Text input**: border-subtle → focus border-accent + ring; placeholder
  `fg-muted`.
- **Segmented control**: selected = 2px accent underline.
- **Backlink row**: divided list; search-match `<mark>` = accent fill.

## Screens

1. **Workspace** — topbar, file tree (using FileTreeRow), CodeMirror 6
   Markdown editor column (real, token-themed), right sidebar with
   Backlinks/Mentions underline tabs (SegmentedControl-style), status bar,
   minimap.
2. **Empty vault** — first-run / no-notes state.
3. **Command palette** — omni-bar overlay (Modal + Menu composition),
   invocable from the workspace.
4. **Settings** — includes the theme switcher (light/dark/high-contrast).
5. **Gallery** — custom-built showcase route (not Storybook) rendering every
   component in every state side by side, with a theme switcher so all three
   themes can be checked in place.

## Verification plan

- Dev server (`npm run dev`) kept running throughout the build.
- Each component's full state matrix checked visually in the Gallery screen
  before moving to the next component group.
- Each screen manually exercised in-browser (not just typechecked) before
  being marked done: workspace interactions (select file, open command
  palette, switch sidebar tabs), empty-vault, settings (theme switching
  actually swaps `[data-theme]` and repaints), gallery.
- `tsc --noEmit` clean and no React/CSS-in-JS/Tailwind deps in
  `package.json` as a final sanity check.

## Explicit exclusions (YAGNI)

- No real file system access, no vault persistence, no search indexing logic.
- No routing library.
- No actual Storybook install.
- No backend, no sync, no plugin system — this is the design system + screen
  mockups only.
