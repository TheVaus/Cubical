# Cubical Design System

A SolidJS design system for **Cubical**, a local-first Markdown knowledge base.
Design language: "Machinist / Graphite" — chrome recedes, the user's text is
the loudest thing on screen.

## The one rule

`--c-accent` means exactly one thing: **state** — selection, active, focus,
caret, resolved wiki-links and tags. It is never used as brand decoration.
Identity is carried by the warm-neutral surface and the cube mark. Saturated
color (`--c-success` / `--c-warning` / `--c-error`) is rationed to status only.

## Getting started

    npm install
    npm run dev

Open the printed local URL. The dev switcher at the top of the page moves
between the Gallery, Workspace, Empty vault, and Settings screens.

## Tokens

All values live in `src/styles/tokens.css`: an un-themed base layer (spacing,
radii, type ramp, motion, elevation) and three theme scopes
(`[data-theme="light|dark|high-contrast"]`) that override the semantic color
aliases (`--c-bg-*`, `--c-fg-*`, `--c-border-*`, `--c-accent`, status colors).
Components reference semantic aliases only — never raw hex.

## Components

[`INVENTORY.md`](INVENTORY.md) lists every component with its import path and
props, generated from the source tree. **Read it before hand-rolling a control**
— that is the point of the list, and a stale copy of it here would defeat it.

Every component's states are demonstrated on the Gallery screen
(`src/screens/Gallery`), including the theme switcher so all three themes can
be checked in place.

## Iconography

Icons come from the `Icon` component (`components/graphics/Icon`), backed by a
registry of artwork vendored inline from **Lucide** (ISC — see
`components/graphics/Icon/LUCIDE-LICENSE`). No runtime icon dependency ships;
`lucide-static` is a build-time source only.

- Outline only, drawn on Lucide's 24-unit grid, rendered at 16px by default via
  `currentColor` — no filled or multi-color icons.
- Decorative by default (`aria-hidden`); the accessible name comes from the
  wrapping control's label. Pass `title`/`ariaLabel` only for a standalone icon.
- To add an icon: copy the inner SVG markup from the pinned `lucide-static`
  package into the registry and extend the `IconName` union. Do not hand-draw.

## Screens

- **Workspace** — topbar, file tree, a real CodeMirror 6 Markdown editor,
  right sidebar (Backlinks / Mentions), status bar, minimap.
- **Empty vault** — first-run state.
- **Settings** — theme switcher.
- **Gallery** — full component state matrix.

## Conventions

- Solid idioms only (`createSignal`, `createMemo`, `<Show>`, `<For>`, props
  accessed as `props.x`).
- No hardcoded hex values in component CSS — every color is a token. Fixed
  control-size dimensions (button/input heights, icon sizes) are currently
  literal px values — a `--control-height-*` token scale is a known gap,
  not yet added.
- Motion is `transform`/`opacity` only: 120ms for state, 200ms for surfaces.
  `prefers-reduced-motion` collapses both to 0ms.
