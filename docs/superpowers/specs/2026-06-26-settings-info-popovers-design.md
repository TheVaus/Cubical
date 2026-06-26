# Settings info popovers

**Date:** 2026-06-26
**Status:** Design — approved, pre-implementation
**Surface:** Settings modal in `ui/src/App.tsx`

## Problem

Complex settings (Dataview, Property references, Typed properties, broken-link
repair) need more explanation than a one-line description affords. Today the
only setting with rich docs is Typed Properties, whose "how it works" block
expands *inline* in the panel and clutters it. We want on-demand explanations,
opened from a small info button next to each complex setting's toggle.

## Goal

Add an `ⓘ` button beside the **Off/On** toggle of each *complex* setting. Clicking
it opens a small inline popover anchored below the button, holding a plain-English
explanation and — for the data-ish features — one minimal example. Self-explanatory
settings (Theme, Show status bar, raw-source default, status-bar segments, etc.)
get **no** button.

Non-goals: no slide-in panel, no full-screen overlay, no generic settings-row
component refactor, no changes to how settings are stored or toggled.

## Which settings get the button

Exactly four, all in the existing tabs:

| Tab        | Setting                          | Popover id       |
| ---------- | -------------------------------- | ---------------- |
| Editor     | Typed properties                 | `typed-props`    |
| Wiki links | Repair broken links on rename    | `wiki-repair`    |
| Plugins    | Dataview                         | `dataview`       |
| Plugins    | Property references              | `property-refs`  |

## Approach

Chosen: **single open-state signal + inline absolutely-positioned popovers**
(Approach A of three considered). It adds no new components and matches how the
modal is already written — settings JSX lives directly in `App.tsx`, content is
authored inline next to each row, exactly like today's Typed Properties block.

Rejected:
- **B — `info` field on definitions + generic `<SettingRow>`**: cleaner data/view
  split but forces pulling all settings JSX out of `App.tsx`; refactor scope far
  exceeds the task.
- **C — native `<details>/<summary>`**: no positioning math, but content pushes
  layout down instead of floating; less polished.

## State

One signal in the `App` component:

```ts
const [openInfo, setOpenInfo] = createSignal<string | null>(null);
```

Holds the id of the open popover (`"typed-props" | "wiki-repair" | "dataview" |
"property-refs"`) or `null` when none is open. The `ⓘ` button toggles:
clicking the same id again closes it. Reset to `null` whenever the settings
modal closes (fold into the existing `setSettingsOpen(false)` paths) and on
settings-tab change (a popover from another tab must not linger).

## Layout & markup

Each of the four rows already ends in a `<div class="seg-control">`. Wrap the
right-hand side in a positioned container so the popover can anchor to the button:

```tsx
<div class="set-row__control">
  <button
    type="button"
    class="set-info-btn"
    aria-label="About this setting"
    aria-expanded={openInfo() === "dataview"}
    onClick={() => setOpenInfo((v) => (v === "dataview" ? null : "dataview"))}
  >
    ⓘ
  </button>
  <div class="seg-control"> … existing Off/On buttons … </div>
  <Show when={openInfo() === "dataview"}>
    <div class="set-info-pop" role="dialog" aria-label="Dataview help">
      … content …
    </div>
  </Show>
</div>
```

Outside-click close: a single transparent fixed backdrop rendered once (guarded
by `<Show when={openInfo() !== null}>`), `onClick={() => setOpenInfo(null)}`,
sitting just below the popover in z-order. The popover stops propagation so a
click inside it doesn't close it.

### CSS (in `ui/src/styles/layout.css`, beside the existing `.set-row` block)

- `.set-row__control` — `position: relative; display: flex; align-items: center;
  gap: var(--space-2); flex: 0 0 auto;`
- `.set-info-btn` — ~20px circular, transparent background, `color:
  var(--c-fg-muted)`, no border; hover → `color: var(--c-accent)`; `cursor:
  pointer`. Inherits the modal font.
- `.set-info-pop` — `position: absolute; top: calc(100% + var(--space-1));
  right: 0; z-index: 20; max-width: 320px; width: max-content; padding:
  var(--space-3); background: var(--c-bg-primary); border: 1px solid
  var(--c-border-subtle); border-radius: var(--radius-md); box-shadow:
  var(--shadow-md); font-size: var(--text-xs); color: var(--c-fg-secondary);
  text-align: left;`. Right-aligned so it never overflows the modal's right
  edge. Code/example blocks inside reuse the same `--font-mono` / `--c-bg-primary`
  framed style the current Typed Properties example uses.
- `.set-info-backdrop` — `position: fixed; inset: 0; z-index: 19; background:
  transparent;`

## Popover content

### Dataview (`dataview`)
One sentence on what a `query` block does, then one minimal fenced example:

````
```query
from #project where status = "active"
```
````

### Property references (`property-refs`)
What `[[note.prop]]` and `[[.prop]]` render to (inline frontmatter values), with
one example showing a referenced note's frontmatter plus an inline `[[note.prop]]`
in body text.

### Typed properties (`typed-props`)
The content currently living in the inline "how it works" block (lines ~2204–2302
of `App.tsx`): the brief explanation, the type-token table, and the example
frontmatter. **Move it verbatim** out of its current inline `<Show
when={typedProps()}>` position and into this popover; condense only as needed to
read well at `max-width: 320px`. After the move, the Editor tab no longer expands
that block inline.

### Repair broken links on rename (`wiki-repair`)
Two sentences contrasting on vs. off: **On** also fixes links that point at a
file's old name but had already broken from an earlier rename; **Off** limits a
rename to links that still resolve to the file.

## Out of scope / preserved behavior

- The Typed-properties default **date format** and **default currency** rows, and
  the **Render "tags" as tags** row, stay where they are (they only appear when
  typed props is on). Only the *explanatory* block moves into the popover; these
  remain functional controls in the panel.
- Toggle behavior, persistence, seeding — unchanged.
- No `ⓘ` on simple rows.

## Testing

Component/unit coverage in the existing vitest suite:
- Clicking `ⓘ` opens the matching popover; clicking it again closes it.
- Opening one popover while another is open switches (only one `openInfo` at a
  time — covered by the single-signal shape).
- Backdrop click closes the open popover.
- Switching settings tab clears any open popover.
- The four ids render their button; simple rows render none.

Manual/preview verification: open Settings, confirm each of the four buttons
opens readable, correctly-anchored content that doesn't overflow the modal, in
both light and dark themes.
