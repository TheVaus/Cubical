# Implementation — stylesheet layering

Theming and component-library ownership live in
[`../architecture/ui.md`](../architecture/ui.md) §11.4 and §11.6. This file
records the CSS-layer implementation rules.

## Token re-export

**Anchors:** tokens

`design-system/src/styles/tokens.css` is the canonical palette. The app's
`ui/src/styles/tokens.css` re-exports it and defines nothing of its own, so a
value edited in the design system propagates to every instance in the app.

The design-system file is a **superset**: its own token vocabulary plus the
app-compat aliases the app references by name. Keep the aliases wired to the
canonical tokens rather than giving them independent values — **never add token
values app-side.**

## Stylesheet roles

| File | Owns |
|---|---|
| `tokens.css` | the variable surface (re-export only, app-side) |
| `base.css` | element resets and base styles, consuming tokens; no hardcoded design values |
| `layout.css` | app chrome layout — the shell, not component internals |

The layout model: full-width top and status bars, a positioning-context stage,
a fixed centred editor layer that never moves, and floating sidebar layers that
slide off-screen on collapse **without reflowing the editor underneath**.

The top bar's flanks are fixed at the sidebar widths so the centre region maps
exactly onto the editor regardless of collapse state.

The editor pane has a single scroll viewport: title, properties and document
text scroll together, so a tall properties block rolls up off the top instead
of staying pinned. Its content sizes to content but fills the viewport at
minimum, so a short note still paints a full-height surface.

## No rubber-band overscroll

`overscroll-behavior` is applied universally so each scroll pane (editor,
sidebars, search, modals) stops dead at its edge instead of bouncing, and never
chains overscroll up to the webview document. The document itself never
scrolls — all scrolling lives in inner panes.

This is what gives the app a native feel rather than a web-page feel; the
universal selector is free on non-scroll-containers.

## Design-system components are self-contained

A design-system component may **not** depend on the playground's global
stylesheets. Each component's CSS carries its own control reset
(font/background/border/padding/cursor) so it renders correctly in a host with
no `button` reset of its own — and the app deliberately ships none.

This rule is locked in [`../architecture/ui.md`](../architecture/ui.md) §11.6;
the CSS-side consequence is that "just inherit it from `base.css`" is never an
acceptable fix for a component.

## Overlay content vs overlay chrome

Where the app passes a class into a design-system overlay (`Popover`, `Modal`),
that class supplies **content layout and typography only**. Overlay chrome —
position, background, border, radius, shadow, z-index — comes from the DS panel
itself.

Keep the split: re-declaring chrome app-side is how the two drift apart.

Related: a modal scrim is a true dim for figure/ground separation, not the
subtle overlay tint token (which is a light-on-dark 5% tint — the wrong
direction for a scrim).
