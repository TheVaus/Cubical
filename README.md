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

- `forms/` — Button, IconButton, TextInput, Toggle, SegmentedControl
- `feedback/` — Badge, Callout, Toast, Tooltip
- `overlay/` — Menu, Modal, CommandPalette
- `data/` — Tag, FileTreeRow, BacklinkRow
- `brand/` — CubeMark

Every component's states are demonstrated on the Gallery screen
(`src/screens/Gallery`), including the theme switcher so all three themes can
be checked in place.

## Screens

- **Workspace** — topbar, file tree, a real CodeMirror 6 Markdown editor,
  right sidebar (Backlinks / Mentions), status bar, minimap.
- **Empty vault** — first-run state.
- **Settings** — theme switcher.
- **Gallery** — full component state matrix.

## Conventions

- Solid idioms only (`createSignal`, `createMemo`, `<Show>`, `<For>`, props
  accessed as `props.x`).
- No hardcoded hex or px values in component CSS — everything is a token.
- Motion is `transform`/`opacity` only: 120ms for state, 200ms for surfaces.
  `prefers-reduced-motion` collapses both to 0ms.
