> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Colorize Raw Source (syntax coloring, no rendering) — Design

**Date:** 2026-06-28
**Status:** Design — awaiting review
**Feature toggle:** `editor.colorize_raw_source` (composable on/off block, **default off**)
**Dependency:** none (uses the already-bundled `@lezer/highlight` + `@codemirror/language`)

---

## 1. Why this

Cubical's editor has two display states today:

- **Live Preview** (`livePreviewBundle`) — colors tokens **and** hides/replaces
  markup: `[[…]]` brackets vanish, heading `#` disappears, headings scale,
  embeds/dataview/property-refs become widgets, frontmatter collapses.
- **Raw Source** (`decorationCompartment` → `[]`) — every transformation is
  killed, leaving **plain monochrome markdown**. There is no
  `syntaxHighlighting` in the editor's base extensions, so raw mode has *zero*
  coloring.

There is a missing middle a writer often wants: see the literal source —
every bracket, every `#`, nothing hidden or moved — but with the **same
colors** the rendered view uses, so a `[[wikilink]]` still reads as purple
(`--c-accent`), a `#tag` is tinted, a `[text](url)` link is colored. No
rendering occurs; only `color` changes.

This is the feature: a sub-toggle of Raw Source that paints rendered-mode
colors onto the raw markup without hiding or replacing a single character.

### Non-negotiables check

- **`.md` is SSOT** — pure derived view styling; reads the buffer, writes
  nothing to disk. ✓
- **Composable on/off block** — gated on `editor.colorize_raw_source`, default
  off; when off (or when not in Raw Source), the compartment holds `[]` and
  zero styling runs. ✓
- **No Node runtime** — `HighlightStyle` / `syntaxHighlighting` are already in
  the bundle via `@codemirror/language`. No new dependency. ✓
- **Desktop only for v1** — no platform-specific work. ✓

---

## 2. Scope

### In scope (v1)

- A new vault-local setting `editor.colorize_raw_source` (boolean, default
  `false`), surfaced as a toggle in **Settings ▸ Editor** beside the existing
  raw-source / minimap toggles.
- A `HighlightStyle` mapping Lezer highlight tags to the **same design tokens**
  rendered mode uses:
  - `t.link` → `var(--c-accent)` — covers both `[[wikilinks]]` (the `WikiLink`
    node is style-tagged `t.link`) and standard `[text](url)` links.
  - `t.labelName` → `var(--c-accent)` — covers `#tags` (the `Tag` node is
    style-tagged `t.labelName`).
- The style applies **only** when Raw Source is active **and** the setting is
  on. Live Preview is untouched (it already colors).

### Out of scope (deliberate — "only colors change")

- **No** weight/italic/size/background styling. Rendered bold/italic/inline-code/
  headings get their effect from weight/size/bg, none of which is a *color*, so
  raw mode leaves them at the default foreground. Faithful to the request.
- **No** `^block-id` muting, no h6 muting, no blockquote tinting. These are
  rendered-mode minutiae; `^block-id` isn't even a Lezer node (it's doc-scanned
  in `decorations.ts`), so a `HighlightStyle` structurally cannot reach it.
- **No** unresolved-wikilink distinction (the dashed warning color). That needs
  the live wiki-link resolver, which raw mode does not wire in. All wikilinks
  paint resolved-style `--c-accent`. Acceptable: this is coloring, not linting.
- **No** new mode in the toggle UI / status bar. It is a setting that modifies
  the existing Raw Source state, not a third top-level mode.

---

## 3. Architecture

### 3.1 New module — `ui/src/editor/colorSource.ts`

Exports a single composed `Extension`:

```ts
export const colorSourceHighlight: Extension =
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.link, color: "var(--c-accent)" },      // wikilinks + md links
      { tag: t.labelName, color: "var(--c-accent)" }, // #tags
    ]),
  );
```

Using `var(--c-accent)` directly (rather than a computed snapshot à la
`cm-theme.ts`) is correct here: `HighlightStyle` injects a CSS rule, and the
`var()` resolves against `:root` at paint — so it re-themes on light/dark flip
for free, exactly like `decorationBaseTheme` in `decorations.ts`. One source of
truth for the accent color, shared with rendered mode.

This extension **only** sets `color`. A `HighlightStyle` cannot hide, replace,
or move text — so the "no rendering" guarantee is structural, not a convention.

### 3.2 Editor wiring — `ui/src/Editor.tsx`

- New `colorSourceCompartment = new Compartment()` (alongside
  `decorationCompartment`).
- Installed in the base extension list with initial content
  `props.rawSource && props.colorizeSource ? colorSourceHighlight : []`.
- New `createEffect` reconfiguring the compartment whenever **either**
  `props.rawSource` or `props.colorizeSource` changes — parallel to the
  existing raw-source effect. The gate is `rawSource && colorizeSource`.
- New `colorizeSource: boolean` field on `EditorProps`.

The two compartments stay independent and single-purpose: `decorationCompartment`
owns the live-preview bundle, `colorSourceCompartment` owns the raw-source
coloring. They are mutually exclusive at runtime by construction — coloring is
gated on `rawSource`, the bundle on `!rawSource` — but neither references the
other.

### 3.3 Setting — `ui/src/api/ipc.ts`

Extend the `Setting` discriminated union:

```ts
| { key: "editor.colorize_raw_source"; value: boolean }
```

### 3.4 App state — `ui/src/App.tsx`

Mirror the `minimap_enabled` wiring exactly (it is the closest precedent — a
boolean editor toggle seeded on vault open, persisted on change):

- `const [colorizeSource, setColorizeSource] = createSignal(false)`.
- `setColorizeSourceValue(val)` → set signal + `persistSetting(vaultId(),
  "editor.colorize_raw_source", val)`.
- `seedSetting(id, "editor.colorize_raw_source", false, setColorizeSource)` in
  the vault-open seeding block (next to the minimap seed).
- Pass `colorizeSource={colorizeSource()}` to `<Editor>`.
- A toggle row in **Settings ▸ Editor** (label e.g. "Colorize markup in raw
  source", helper "Apply rendered-mode colors to the raw markdown — wikilinks,
  links and tags are tinted, but nothing is hidden or rendered.").

---

## 4. Data flow

```
vault open ─seedSetting─▶ colorizeSource signal ─prop─▶ Editor.colorizeSource
                                                          │
  Settings toggle ─setColorizeSourceValue─▶ signal ──────┤
                                                          ▼
                          createEffect( rawSource && colorizeSource )
                                                          │
                              reconfigure colorSourceCompartment
                                   [] ◀──── false        │ true ────▶ colorSourceHighlight
                                                          ▼
                                        Lezer tags painted with --c-accent
```

`rawSource` is the existing `effectiveRaw()` (app default + per-doc override,
unchanged). When the document leaves raw source — via the `</>` toggle — the
gate goes false and the compartment empties with no extra plumbing.

---

## 5. Testing

- `ui/src/editor/colorSource.test.ts` — assert the `HighlightStyle` resolves
  the expected tags (`t.link`, `t.labelName`) to the accent token, and that the
  exported extension is a non-empty `syntaxHighlighting` extension. (Declarative
  module, so the unit surface is thin by design.)
- The compartment gating reuses the well-tested raw-source toggle pattern; an
  Editor-level integration test asserting "coloring present iff
  `rawSource && colorizeSource`" follows the existing `rawSource` reconfigure
  test if one exists, otherwise is verified by preview in the Tauri shell.
- `seedSetting`/`persistSetting` already have core coverage in
  `settings.test.ts`; the new key needs no new substrate test (the substrate is
  key-generic).

---

## 6. Risks & notes

- **`t.link` colors regular markdown links too.** Intended — rendered mode also
  paints `[text](url)` with `--c-accent`. Parity, not a bug.
- **`HighlightStyle` vs decoration precedence.** Irrelevant: the two never apply
  together (coloring is gated on `rawSource`, live-preview decorations on
  `!rawSource`).
- **Selection/caret color** is owned by `cm-theme.ts` and untouched.
