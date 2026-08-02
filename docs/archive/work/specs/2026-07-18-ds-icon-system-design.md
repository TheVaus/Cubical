> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# DS Icon system + app adoption — Design Spec

Date: 2026-07-18
Status: approved (brainstorm) → ready for implementation plan

## Summary

The design system has no icon system. It ships exactly two hand-drawn SVG marks
— `CubeMark` (brand) and `FileIcon` (10 file kinds, a `data/` component) — while
the app scatters ~21 ad-hoc Unicode glyphs and emoji as UI icons (`＋ 🗀 ⓘ ▸ ▾ ⌄
✕ ✎ ⚙ ⚠ 🔗 📝 📊 🎨 🧩 🗄 ⌨ ☀ ☾ # ⚡ ◧`). These render differently per-OS, don't
respect stroke/theme, and don't align to the 16px/1.3-stroke Machinist grid the
two bespoke marks use.

This project adds a proper **`Icon` component + a vendored, unified icon set** to
the design system, showcases it in the Gallery, and **adopts it across the app**
so the real UI-affordance glyphs become coherent, themeable icons. Artwork is
sourced from **Lucide** (ISC-licensed), vendored inline.

This is the "assets / icons" pillar of the larger *make-the-DS-complete* effort.
The other two pillars are tracked separately: components (issue #35) and a durable
design-language doc (a small slice of which lands here — see §8).

## Goals

- One typed `Icon` component that renders any icon in the set at any size, in
  `currentColor`, on the 16px grid.
- A unified icon set whose visual language matches Cubical's brand — sourced from
  Lucide, not hand-drawn one-by-one.
- Every genuine UI-affordance glyph in `ui/src` replaced by an `Icon`.
- Self-containment preserved: no runtime icon dependency, no CDN, no asset
  pipeline. Everything inline.
- Gallery showcase + tests + live smoke proving it renders in the real app.

## Non-goals

- Not migrating the deliberately-bespoke *components* (Select/Popover/etc., issue
  #35) — this is icons only.
- Not replacing prose/typographic characters (`— → § ·`) or **keycaps** (the
  `⌘/Ctrl` symbols in help text, the `Settings ▸ Appearance` breadcrumb, the
  `<code>▾</code>` doc example). Those are text, not affordances.
- Not redrawing `CubeMark` or `FileIcon`. Lucide *is* the maintained continuation
  of the thin-outline / round-join language they already use, so they stay
  bespoke and sit coherently beside the vendored set. They only adopt the shared
  grid constant (§3).
- No speculative icons — we vendor exactly the set the app uses (§4). New icons
  are a one-line registry addition later.

## The constraint reconciliation — "unified library" vs "no CDN / self-contained"

The DS is strictly local-first and self-contained (a non-negotiable): a new DS
component may not depend on external hosts or the DS playground's globals. So we
do **not** add `lucide-solid` or any runtime icon dependency. Instead we **vendor
the SVG path data inline**: copy the exact `<path>`/geometry for the ~21 icons we
need from Lucide into the registry (§3). This yields a professionally-designed,
unified set while keeping every icon inline and offline — identical to how
`FileIcon` already embeds its path data.

Lucide is ISC-licensed; vendoring requires retaining the license. We add
`design-system/src/components/graphics/Icon/LUCIDE-LICENSE` (the upstream ISC
text) and a header comment in the registry crediting Lucide + the commit/version
the paths were copied from. Icons we redraw or that diverge are noted as such.

## Architecture

**One component + a typed registry** (the pattern `FileIcon` already uses,
generalized — chosen over per-file icon components and over an SVG-sprite/asset
pipeline, both of which add ceremony or a build concern without benefit for a
fixed in-house set).

New `graphics/` component category (icons are neither `brand` nor `data`):

```
design-system/src/components/graphics/
├── svg.ts                 # shared grid constants (viewBox, stroke, linecap/join)
├── Icon/
│   ├── Icon.tsx           # <Icon name size .../> — reads the registry, renders <svg>
│   ├── icons.tsx          # NAME → path-geometry registry (vendored Lucide)
│   ├── Icon.css           # sizing / display
│   └── LUCIDE-LICENSE     # upstream ISC license text (attribution)
```

- `svg.ts` exports only the **invariant** drawing constants all three marks share
  — `fill: "none"`, `stroke: "currentColor"`, round `stroke-linecap`/
  `stroke-linejoin`. `viewBox` and `stroke-width` stay **per-component**: `Icon`
  uses Lucide's `0 0 24 24` grid (rendered at 16px — stroke scales, so a 24-unit
  viewBox and a 16px render size coexist fine), `CubeMark` keeps `0 0 24 24` /
  1.6, `FileIcon` keeps `0 0 16 16` / 1.3. `CubeMark` and `FileIcon` are refactored
  only to import the shared invariants — a light touch, zero visual change — so
  there's one source for the drawing convention.
- `icons.tsx` maps each `IconName` to its SVG children (paths/circles/lines). The
  `IconName` union is the single source of which icons exist; adding one is a
  one-entry change.

`@ds` already resolves `design-system/src`, so the app imports
`import { Icon } from "@ds/components/graphics/Icon/Icon"` (matching existing
`@ds` import style).

## The icon set — Lucide mapping

Exactly the affordances the app uses today. **Intended Lucide icon** is named;
the precise current export name is confirmed at vendor-time (Lucide has renamed a
few over versions — e.g. `alert-triangle` → `triangle-alert`), so the registry
`IconName` is our own stable semantic name, decoupled from Lucide's.

| `IconName` | Lucide source | Replaces | App usage |
|---|---|---|---|
| `plus` | `plus` | ＋ | tree "New file" |
| `folder-plus` | `folder-plus` | 🗀 | tree "New folder" |
| `info` | `info` | ⓘ | Properties set-info button |
| `chevron-right` | `chevron-right` | ▸ | tree/Properties collapsed, generic disclosure |
| `chevron-down` | `chevron-down` | ▾ ⌄ | tree/Properties expanded, vault-switcher caret |
| `close` | `x` | ✕ × | close panel, remove chip |
| `edit` | `pencil` | ✎ | rename / edit chip |
| `settings` | `settings` (gear) | ⚙ | Settings button, system-theme icon |
| `warning` | `triangle-alert` | ⚠ | lossy-revert, malformed YAML |
| `sun` | `sun` | ☀ | theme cycle — light |
| `moon` | `moon` | ☾ | theme cycle — dark |
| `link` | `link` | 🔗 | Settings nav — Wiki links |
| `file-text` | `file-text` | 📝 ◧ | Settings nav — Editor; OmniBar note kind |
| `bar-chart` | `bar-chart-3` | 📊 | Settings nav — Status bar |
| `palette` | `palette` | 🎨 | Settings nav — Appearance |
| `puzzle` | `puzzle` | 🧩 | Settings nav — Plugins |
| `library` | `library` | 🗄 | Settings nav — Vault *(taste call, see §10)* |
| `keyboard` | `keyboard` | ⌨ | Settings nav — Shortcuts |
| `hash` | `hash` | # | OmniBar tag kind |
| `command` | `command` | ⚡ | OmniBar command kind |

~20 semantic names (theme `system` reuses `settings`; note kind reuses
`file-text`). One entry per row; no duplicates shipped.

## Component API

```tsx
// decorative (the common case): the accessible name is on the wrapping control
<Icon name="plus" />                    // 16px default, currentColor, aria-hidden
<Icon name="warning" size={20} />       // explicit px size
// standalone-semantic (rare): icon carries its own meaning
<Icon name="info" title="Details" />    // role="img" + <title>; not aria-hidden
```

- `name: IconName` — required, typed union.
- `size?: number` — default 16 (px, sets width+height).
- `title?: string` / `ariaLabel?: string` — when set, the icon is announced
  (`role="img"`, `<title>`); when both omitted, the icon is `aria-hidden="true"`.
- `class?` / `style?` — escape hatches (e.g. a one-step-larger settings-nav icon).
- **Decorative by default** because icons almost always sit inside an
  `IconButton`/`Button` whose `label` already provides the accessible name — which
  is exactly how ＋/🗀 work today. This avoids double-announcing.
- Self-contained per the DS rule: sizing/display in `Icon.css` (or inline attrs),
  no dependency on the playground globals.

## Adoption — app files

Swap each affordance glyph for `<Icon>`; leave prose/keycaps.

- **`ui/src/App.tsx`** — tree-header ＋/🗀 (already inside `IconButton`, swap the
  glyph child); set-info ⓘ (a **bespoke** `<button class="set-info-btn">` kept
  bespoke per #35 — swap only the glyph child, do **not** convert it to
  `IconButton`); tree-row collapse ▸/▾; vault-btn caret ⌄; Settings
  gear ⚙; `THEME_ICON` map (`system→settings`, `light→sun`, `dark→moon`);
  settings-nav item labels (the `"🎨 Appearance"`-style strings become an
  `<Icon>` + text label — small structural change to the nav item render);
  close ✕; warning ⚠.
- **`ui/src/Properties.tsx`** — family disclosure ▾/▸; property-row menu ▾;
  warning ⚠.
- **`ui/src/properties/ChipList.tsx`** — edit ✎, remove × (both already inside
  `IconButton` with a `label`).
- **`ui/src/omnibar/OmniBar.tsx`** — result-kind glyphs `#`/`⚡`/`◧` →
  `hash`/`command`/`file-text`. (Icon adoption only; OmniBar stays bespoke per #35.)

Doc/help prose that *describes* a glyph (e.g. the `<code>▾</code>` example, the
`⌘/Ctrl` shortcut text) stays as text.

## Accessibility

- Icons in labeled controls stay `aria-hidden`; the control's `label`/`title` is
  the accessible name (no regression — matches today).
- Standalone icons get `title`/`ariaLabel` → `role="img"`.
- Color is `currentColor`, so contrast follows the inherited text token; no icon
  introduces a new color. Status icons (`warning`) inherit the surrounding status
  color as today.

## Design language — Iconography (pillar-1 slice)

Add a short **Iconography** subsection to `design-system/README.md`: the icon set
is Lucide, vendored inline; drawn outline-only on a 24-unit grid rendered at 16px;
`currentColor`, round joins; icons are decorative by default (labeled by their
control); filled icons and multi-color icons are out of the language. This closes
the "philosophy doesn't mention icons" gap noted in the audit. (The larger
durable design-language doc remains a separate follow-up.)

## Testing & verification

Reality of the harness (verified, not assumed):

- The **design-system package has no test runner** (no vitest, no `test` script,
  no test files). `scripts/check.sh` runs vitest **only in `ui/`**. So the unit
  test lives in the **`ui` suite** — which already resolves `@ds` — not in the DS
  package. This is the first `@ds`-importing test; that's fine.
- `ui` vitest defaults to the **`node`** environment, with `jsdom` opted in
  per-file via `// @vitest-environment jsdom`. There is **no
  `@solidjs/testing-library`**; existing DOM tests use raw `document` (and, where
  a Solid component is involved, `render` from `solid-js/web`).
- Because the app **adopts** `Icon`, the component files (`Icon.tsx`,
  `icons.tsx`, `svg.ts`) are pulled into `ui`'s tsc gate and get type-checked.
  **DS-only files are not** — `check.sh` never type-checks the DS Gallery/screens.
  So Gallery changes are verified by running the DS playground, not by the gate
  (optionally, the plan may add a `cd design-system && npx tsc --noEmit` step to
  `check.sh` to close that hole — a gate change, decide in-plan).

Plan:

- **Unit** (in `ui`, `node` env — pure logic, no DOM): a registry-completeness
  test — every `IconName` has a registry entry that yields non-empty SVG
  geometry, and the `IconName` union and registry keys agree. This is the
  high-value assertion (catches a missing/renamed icon) and needs no DOM harness.
  Optionally a small `jsdom`-env smoke (following `dataviewRender.test.ts`) that
  `render`s one `Icon` and checks default size 16, `aria-hidden` unlabeled, and
  `role="img"` + `<title>` when titled.
- **Gallery** (DS playground): an **Icons** section rendering the full set in a
  labeled grid, checked by eye under all three themes (light/dark/high-contrast)
  in `design-system`'s own dev server. Not gate-covered (see above).
- **Gate**: `scripts/check.sh` green — tsc (now covering `Icon`/`icons`/`svg` via
  adoption), vitest (ui suite stays green through adoption + the new test),
  build, cargo fmt/clippy/test, docs.
- **Live smoke**: `cargo tauri dev` against `feature-test-vault` — confirm the
  adopted glyphs render as crisp icons in the real app (tree header, Properties
  disclosure + warning, settings nav + gear + theme cycle, ChipList edit/remove,
  OmniBar kinds). Technique + setup: the `project-tauri-live-verify-setup` memory.
  Verify the vault is left byte-for-byte.

## Out of scope / follow-ups

- Components (#35) and the full durable design-language doc (beyond the
  Iconography slice) remain separate.
- If later we want the *whole* Lucide set available (not just the vendored ~21),
  revisit the vendor-inline vs `lucide-solid`-dependency tradeoff then — but only
  if a concrete need appears (YAGNI).

## Open taste calls (decide in-plan, low-stakes)

- **Vault section icon.** `library` (books) vs `database` (the vault-as-store) vs
  `archive` (box). Default `library`; final pick during the settings-nav slice.
- **`edit` glyph.** Lucide `pencil` vs `square-pen`. Default `pencil` (matches the
  minimal ✎ it replaces).
