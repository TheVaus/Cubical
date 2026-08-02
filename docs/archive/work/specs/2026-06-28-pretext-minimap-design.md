> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Document Minimap (Pretext text layer) — Design

**Date:** 2026-06-28
**Status:** Design — awaiting review
**Feature toggle:** `editor.minimap_enabled` (composable on/off block, **default off**)
**Dependency:** `@chenglou/pretext` (zero-dependency TS text-layout engine)

---

## 1. Why this, and why Pretext

A minimap is a thin, read-only strip beside the editor that renders the
**whole** note at scale, with a draggable viewport indicator — a spatial
overview + fast-scroll affordance.

This is the one place in Cubical where [Pretext](https://github.com/chenglou/pretext)
does something the DOM structurally cannot, and the reasoning is load-bearing:

- CodeMirror 6 **virtualizes** — only lines near the viewport exist in the
  DOM. A minimap needs *every* line laid out, including off-screen ones. You
  therefore cannot CSS-scale the editor DOM to make a minimap; the off-screen
  lines aren't there to scale.
- Laying out the full document independently is exactly Pretext's job:
  segment + measure each line once via Canvas `measureText`, then treat
  wrapping/height as arithmetic on cached widths. Rendering is plain
  `ctx.fillText` to a canvas.

Critically, this surface is a **companion to** CodeMirror, never a replacement
*in* it. It never touches the `contenteditable`, never owns layout for editable
text (which must stay the browser's job so the caret/selection stay correct),
and writes nothing to disk. It is pure **derived state**: rebuildable from the
open buffer at any moment, switchable off with no trace.

### Non-negotiables check

- **`.md` is SSOT** — minimap reads the open buffer, writes nothing. ✓
- **Composable on/off block** — gated on `editor.minimap_enabled`, default
  off; when off, zero code runs and the DOM node isn't mounted. ✓
- **No Node runtime** — Pretext is TypeScript bundled by Vite into the webview,
  like `codemirror`. No new runtime. ✓
- **Desktop only for v1** — pointer/drag interactions only; no mobile work. ✓

---

## 2. Scope

### In scope (v1)

- A toggleable canvas strip on the editor's right edge.
- Pretext lays out the full note at minimap scale; rendered to canvas as
  faithful tiny text (Approach A — see §6), themed from the CM theme tokens.
- A viewport-indicator rectangle showing the editor's currently-visible range.
- Click and drag on the strip to scroll the editor.
- Relayout debounced on edit; indicator repositioned cheaply on scroll
  (no relayout).
- Light/dark re-theme in lockstep with the editor.

### Out of scope (explicitly deferred)

- Syntax-colored "block" rendering (VSCode style) — Approach B, §6.
- Hover-preview tooltips, search-match highlights, diff markers.
- The L9 WebGPU graph view. This spec is a *self-contained evaluation* of the
  Pretext text layer that the graph view may later reuse; it does not design
  or pre-commit that feature.
- Proportional "sliding" minimap for documents too long to scale-to-fit at the
  floor line-height — see §6 for the v1 fallback and the v2 note.

---

## 3. Architecture & module boundaries

One concern per unit (SRP). New code lives under `ui/src/editor/minimap/`.

```
ui/src/editor/minimap/
  pretextLayout.ts    Pure. Wraps Pretext. (text, width, font, lineHeight)
                      -> MinimapLayout { lines: LaidLine[], contentHeight }.
                      measureText injected, so it is unit-testable headless.
  minimapRender.ts    Pure-ish. Draws a MinimapLayout + a viewport rect to a
                      CanvasRenderingContext2D. Takes ctx + colors; no DOM
                      lookup, no Pretext. Testable with a mock 2D context.
  minimapGeometry.ts  Pure. The scroll<->strip mappings:
                      fractionFromClientY(), scrollTopForFraction(),
                      indicatorRect(viewportInfo). Tiny, fully unit-tested.
  Minimap.tsx         Solid component. Owns the <canvas>, observes the
                      EditorView (doc, scroll, theme), debounces relayout via
                      pretextLayout, paints via minimapRender, and routes
                      pointer drags through minimapGeometry to view scroll.
```

**Boundary into the editor.** `Minimap.tsx` receives the live `EditorView`
as a prop. This is acceptable because the minimap is a *view onto* the editor:
it only **reads** (`view.state.doc`, `view.scrollDOM`, viewport geometry) and
**scrolls** (`view.scrollDOM.scrollTop = …`). It never dispatches a document
change, so the "Solid stays out of CM editing" contract in `Editor.tsx` holds.

`Editor.tsx` gains:

- A new optional prop `minimapEnabled?: boolean` (default false).
- A `cmView` signal set in `onMount` so the view can be handed to a child
  reactively (the view is created imperatively; the signal bridges it into JSX).
- A layout change: the component currently returns the bare CM host `<div>`.
  It will return a **flex row** wrapping the CM host (`flex: 1`) and, when
  enabled and the view exists, `<Minimap view={cmView()!} … />` (fixed width).
  No change to how the CM host itself is created.

```
return (
  <div style={{ display: "flex", flex: 1, "min-height": 0 }}>
    <div ref={host} style={{ flex: 1, "min-width": 0, /* existing styles */ }} />
    <Show when={props.minimapEnabled && cmView()}>
      {(v) => <Minimap view={v()} resolvedTheme={props.resolvedTheme} />}
    </Show>
  </div>
);
```

This keeps every other consumer of `Editor` unchanged (the prop is optional and
defaults off) and adds no new dependency to `Editor.tsx` beyond importing the
component.

---

## 4. Data flow

```
                 docChanged (debounced 200ms)
EditorView.doc ───────────────────────────► pretextLayout.layout()
                                                    │  MinimapLayout
                                                    ▼
scrollDOM.scroll (rAF-throttled) ──► indicatorRect ─► minimapRender.draw(ctx)
                                                    ▲
resolvedTheme flip ─────────► re-read colors ───────┘

pointerdown/move on canvas ─► minimapGeometry.scrollTopForFraction()
                                                    │
                                                    ▼
                                       view.scrollDOM.scrollTop = …
```

- **Relayout** (the expensive Pretext `prepare`+`layout`) runs only when the
  document text changes, debounced 200 ms, and once on mount.
- **Redraw** runs on relayout, on editor scroll (just repaints; the indicator
  rect moves, layout is reused), and on theme flip. Scroll redraws are
  rAF-throttled and do **not** call Pretext.
- **Resize** of the strip (window/pane resize) triggers a relayout (width
  changed) via a `ResizeObserver` on the strip.

---

## 5. The Pretext seam (`pretextLayout.ts`)

```ts
export interface LaidLine { text: string; }            // v1: one wrapped row
export interface MinimapLayout { lines: LaidLine[]; contentHeight: number; }

export interface LayoutInput {
  text: string;
  width: number;        // minimap strip inner width, px
  lineHeight: number;   // minimap row height, px
  font: string;         // CSS font shorthand matching the editor font
}

export function layout(input: LayoutInput): MinimapLayout;
```

Internally calls Pretext's `prepareWithSegments(text, font)` +
`layoutWithLines(prepared, width, lineHeight)` (real signatures, v0.0.8) and
flattens the returned `{ height, lineCount, lines }` into `MinimapLayout`
(`contentHeight = lineCount * lineHeight`, `lines = result.lines.map(l =>
({ text: l.text }))`).

**Measurement is internal to Pretext** — it owns a canvas `measureText` and
needs `Intl.Segmenter`; both exist in the Tauri WKWebView. There is no
`measureText` injection point. Consequently `pretextLayout.ts` is **not**
headless-pure: its unit test **mocks the `@chenglou/pretext` module**
(`vi.mock`) and asserts our wrapper calls `prepareWithSegments`/`layoutWithLines`
with the right args and flattens the result correctly — we test *our* glue, not
Pretext's math. The genuinely pure, exhaustively-tested logic lives in
`minimapGeometry.ts` and `minimapRender.ts`.

**Font fidelity.** The minimap should wrap the way the editor does, so `font`
is derived from the same `--font-mono` / size tokens `cm-theme.ts` already
reads. v1 accepts approximate fidelity (the minimap is an overview, not a
pixel-exact mirror); exact wrap-point parity with CM is a non-goal.

---

## 6. Rendering: Approach A (faithful tiny text)

Chosen over Approach B (VSCode-style colored blocks) because it is the faithful
look **and** it actually exercises Pretext's text layout — the entire point of
adopting it here. B would mostly use line metrics and could be done without
Pretext, so it would not validate the library.

**Scale-to-fit (v1, the only model).** Compute `lineHeight = min(CEIL,
stripHeight / max(lineCount, 1))` with `CEIL = 4px` and **no lower floor**. The
whole document therefore always fits the strip exactly: short notes render at up
to 4px/line (occupying the top of the strip); very long notes render at
sub-pixel line heights (faint, but a faithful overview). There is no second
scroll model and no rendered-line cap.

The canvas is sized to the strip (`height = stripHeight`); the editor's actual
scroll position drives the **indicator** rect, which is independent of the
minimap's own line height (it maps `scrollTop/scrollHeight` onto `stripHeight`).
A proportional "sliding window" for extreme documents (so sub-pixel lines stay
legible) is a documented **v2**, explicitly out of scope here.

**Colors** come from the resolved CM theme tokens (text on the editor
background, indicator using the selection/accent token at low alpha), read the
same way `cm-theme.ts` reads them, so light/dark and future user themes Just
Work.

---

## 7. Interaction (`minimapGeometry.ts` + `Minimap.tsx`)

- **Click**: map `clientY` → fraction of content → `scrollTop`; center the
  clicked position in the editor viewport.
- **Drag**: pointer capture; same mapping continuously until pointerup.
- **Indicator**: a rectangle whose top/height come from
  `indicatorRect({ scrollTop, scrollHeight, clientHeight }, stripHeight)`.

All three are pure functions of numbers — no DOM, no CM — so they are tested in
isolation. `Minimap.tsx` only wires DOM events to them and applies the result
to `view.scrollDOM.scrollTop`.

---

## 8. Settings & persistence

A new boolean setting `editor.minimap_enabled`, default **off**, surfaced in
**Settings ▸ Editor** next to the existing editor toggles (raw-source default,
status bar). Persisted with the existing `persistSetting(vaultId, key, value)`
path.

**IPC touchpoint.** Add to the `Setting` union in `ui/src/api/ipc.ts`:

```ts
| { key: "editor.minimap_enabled"; value: boolean }
```

and accept the key on the Rust settings handler that persists to
`.cubical/config.toml` (see `docs/migration-touchpoints.md`). The value flows
`App.tsx` → `Editor minimapEnabled` prop → conditional `<Minimap>` mount.

It is intentionally **not** modeled as a `CORE_PLUGINS` entry: core plugins
render *content* inside the document (Dataview, property refs); the minimap is
editor *chrome*. It belongs with the editor-chrome settings, mirroring the
status-bar toggle.

---

## 9. Testing strategy

TDD per project convention (`superpowers:test-driven-development`).

- `pretextLayout.test.ts` — `vi.mock('@chenglou/pretext')`; assert our wrapper
  calls `prepareWithSegments`/`layoutWithLines` with the right font/width/
  lineHeight and flattens `{ height, lineCount, lines }` into `MinimapLayout`
  correctly, including the empty-document case.
- `minimapGeometry.test.ts` — exhaustive pure-function tests:
  `fractionFromClientY`, `scrollTopForFraction`, `indicatorRect`, including the
  long-document window math (clamping at both ends).
- `minimapRender.test.ts` — mock `CanvasRenderingContext2D`; assert it draws
  one `fillText` per line at the right y and one indicator rect with the right
  bounds; assert theme colors are applied.
- `Minimap.tsx` — light component test: mounts a canvas, a doc change triggers
  one debounced relayout, a simulated drag sets `scrollDOM.scrollTop`.
- Regression: `Editor` with `minimapEnabled` omitted/false renders exactly as
  before (no extra DOM node).

Gates: `scripts/check.sh` must stay green (fmt/clippy/test, tsc, vitest, build,
docs).

---

## 10. Risks & mitigations

- **Dependency / license.** `@chenglou/pretext` is **MIT** (v0.0.8, zero
  runtime deps) — compatible with Cubical's MIT placeholder. It is young
  (0.0.x); the `pretextLayout.ts` seam means we can swap the layout impl (even
  a hand-rolled monospace measurer) without touching render/geometry/UI if it
  stalls.
- **WKWebView `Intl.Segmenter` / `OffscreenCanvas`.** Verify both exist in the
  Tauri WebView at the targeted OS versions during the prototype task; if
  `OffscreenCanvas` is unavailable, fall back to a detached `<canvas>` for
  measurement.
- **Very large documents.** Canvas max dimension (~32k px) is avoided by
  scale-to-fit; the long-document window path bounds rendered lines to the
  strip height. Relayout cost is bounded by debounce + Pretext's once-per-text
  prepare.
- **Scope creep toward the graph view.** Explicitly out of scope (§2). This
  ships standalone value and is the evaluation gate for committing Pretext to
  L9.

---

## 11. Resolved decisions

1. **Strip placement & width** — right edge, fixed **96px**.
2. **Line height** — `lineHeight = min(4, stripHeight / lineCount)`, no floor
   (scale-to-fit always; §6).
3. **v1 scope** — scale-to-fit only. The proportional sliding window for
   extreme-length documents is deferred to v2 to keep v1 single-session.
