> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# DS Icon System + App Adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the design system a real icon system — a typed `Icon` component backed by a Lucide-sourced, inline-vendored registry — and adopt it across `ui/src` so the app's ~20 ad-hoc Unicode/emoji glyphs become coherent, themeable icons.

**Architecture:** One `Icon` component reads inline SVG markup from a typed registry (`IconName → string`), rendered on Lucide's 24-unit grid at a 16px default via `currentColor`. Artwork is copied from the pinned `lucide-static` package into the registry (no runtime dependency ships — the app imports the vendored source, satisfying the no-CDN/self-contained non-negotiable). `SegmentedControl` gains an additive `icon?` on its options so the theme picker can show real icons.

**Tech Stack:** SolidJS + TypeScript + Vite; vitest (in `ui/`, `node` env with per-file `jsdom` opt-in); Lucide (ISC) as the artwork source via `lucide-static`.

## Global Constraints

- **Self-contained / no CDN (non-negotiable):** the app and its shipped bundle gain **no** runtime icon dependency. `lucide-static` is a **build-time devDependency of the `design-system` package only**, used to source SVG markup that is copied inline. The app imports the vendored `@ds` source, never `lucide-static`.
- **License:** Lucide is ISC. Retain the license at `design-system/src/components/graphics/Icon/LUCIDE-LICENSE` and credit it + the exact `lucide-static` version in the registry header.
- **Solid idioms:** never destructure props; access `props.x`; `class` not `className`; `createSignal`/`createMemo`/`<Show>`/`<For>`.
- **DS components are self-contained:** a new DS component may not depend on the DS playground's global stylesheets (`base.css` reset / `layout.css` utilities). `Icon` sets its own display in `Icon.css`.
- **Extend the DS additively:** every DS change (the `SegmentedControl` `icon?`) defaults to prior behavior.
- **`@ds` import style:** deep imports, e.g. `import Icon from "@ds/components/graphics/Icon/Icon"`. No barrel.
- **Do not migrate bespoke surfaces:** the set-info `<button class="set-info-btn">` and the OmniBar palette stay bespoke (issue #35) — swap only the glyph child, never convert the control.
- **Leave as text (never iconify):** the `⌘/Ctrl` keycaps in help prose, the `Settings ▸ Appearance` breadcrumb, the `<code>▾</code>` doc example, and typographic `— → § ·`.
- **Gate:** `scripts/check.sh` is the single source of green. Vault must be left byte-for-byte after any live smoke.

**Spec:** [`docs/superpowers/specs/2026-07-18-ds-icon-system-design.md`](../specs/2026-07-18-ds-icon-system-design.md)

---

## File Structure

**Create (design-system):**
- `design-system/src/components/graphics/svg.ts` — shared SVG drawing invariants.
- `design-system/src/components/graphics/Icon/icons.ts` — `IconName` union + `ICONS` registry (vendored Lucide markup strings).
- `design-system/src/components/graphics/Icon/Icon.tsx` — the component.
- `design-system/src/components/graphics/Icon/Icon.css` — display/sizing.
- `design-system/src/components/graphics/Icon/LUCIDE-LICENSE` — ISC text.

**Create (ui tests):**
- `ui/src/ds-icon-registry.test.ts` — registry completeness (node env).
- `ui/src/ds-icon-render.test.tsx` — component wiring (jsdom env).
- `ui/src/ds-segmented-icon.test.tsx` — `SegmentedControl` `icon?` (jsdom env).

**Modify:**
- `design-system/src/components/forms/SegmentedControl/SegmentedControl.tsx` — additive `icon?`.
- `design-system/src/components/brand/CubeMark/CubeMark.tsx`, `design-system/src/components/data/FileTreeRow/FileIcon.tsx` — import shared invariants (no visual change).
- `design-system/src/screens/Gallery/Gallery.tsx` (+ `.css`) — Icons showcase.
- `design-system/package.json` — `lucide-static` devDep (build-time only).
- `design-system/README.md` — Iconography note.
- `ui/src/App.tsx`, `ui/src/Properties.tsx`, `ui/src/properties/ChipList.tsx`, `ui/src/omnibar/OmniBar.tsx` — glyph → `Icon` adoption.
- `scripts/check.sh` — add a `design-system` tsc gate (closes the DS type-check hole).

---

## IconName → Lucide slug reference (used throughout)

Registry keys are our own stable `IconName`s; the **slug** is the `lucide-static` file copied from. Verify each slug exists in the pinned version (Lucide occasionally renames; e.g. `alert-triangle` → `triangle-alert`).

| `IconName` | slug | | `IconName` | slug |
|---|---|---|---|---|
| `plus` | `plus` | | `sun` | `sun` |
| `folder-plus` | `folder-plus` | | `moon` | `moon` |
| `info` | `info` | | `link` | `link` |
| `chevron-right` | `chevron-right` | | `file-text` | `file-text` |
| `chevron-down` | `chevron-down` | | `bar-chart` | `bar-chart-3` |
| `close` | `x` | | `palette` | `palette` |
| `edit` | `pencil` | | `puzzle` | `puzzle` |
| `settings` | `settings` | | `library` | `library` |
| `warning` | `triangle-alert` | | `keyboard` | `keyboard` |
| | | | `hash` | `hash` |
| | | | `command` | `command` |

Theme mode → IconName: `system → settings`, `light → sun`, `dark → moon`.
OmniBar kind → IconName: `tag → hash`, `command → command`, else `file-text`.

---

## Task 1: Icon registry + shared SVG invariants

**Files:**
- Create: `design-system/src/components/graphics/svg.ts`
- Create: `design-system/src/components/graphics/Icon/icons.ts`
- Create: `design-system/src/components/graphics/Icon/LUCIDE-LICENSE`
- Modify: `design-system/package.json`
- Test: `ui/src/ds-icon-registry.test.ts`

**Interfaces:**
- Produces: `export type IconName = 'plus' | 'folder-plus' | 'info' | 'chevron-right' | 'chevron-down' | 'close' | 'edit' | 'settings' | 'warning' | 'sun' | 'moon' | 'link' | 'file-text' | 'bar-chart' | 'palette' | 'puzzle' | 'library' | 'keyboard' | 'hash' | 'command'` and `export const ICONS: Record<IconName, string>` from `icons.ts`; `export const SVG_INVARIANTS` from `svg.ts`.

- [ ] **Step 1: Write the failing test**

`ui/src/ds-icon-registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ICONS, type IconName } from "@ds/components/graphics/Icon/icons";

const EXPECTED: IconName[] = [
  "plus", "folder-plus", "info", "chevron-right", "chevron-down",
  "close", "edit", "settings", "warning", "sun", "moon", "link",
  "file-text", "bar-chart", "palette", "puzzle", "library", "keyboard",
  "hash", "command",
];

describe("DS icon registry", () => {
  it("registry keys exactly match the expected IconName set", () => {
    expect(Object.keys(ICONS).sort()).toEqual([...EXPECTED].sort());
  });

  it("every entry is non-empty SVG geometry", () => {
    for (const [name, markup] of Object.entries(ICONS)) {
      expect(markup.length, name).toBeGreaterThan(0);
      expect(markup, name).toMatch(/<(path|circle|line|rect|polyline|polygon)\b/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/ds-icon-registry.test.ts`
Expected: FAIL — cannot resolve `@ds/components/graphics/Icon/icons`.

- [ ] **Step 3: Add `lucide-static` as a build-time devDependency of the DS package**

Run: `cd design-system && npm install --save-dev lucide-static`
Then note the resolved version (e.g. `npm ls lucide-static`) for the registry header.

- [ ] **Step 4: Create the shared invariants**

`design-system/src/components/graphics/svg.ts`:
```ts
// Invariants shared by every inline SVG mark (Icon, CubeMark, FileIcon).
// viewBox and stroke-width stay per-component; only these are shared.
export const SVG_INVARIANTS = {
  fill: "none",
  stroke: "currentColor",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
};
```

- [ ] **Step 5: Vendor the ISC license**

Copy the license text from `design-system/node_modules/lucide-static/LICENSE` into `design-system/src/components/graphics/Icon/LUCIDE-LICENSE` verbatim.

- [ ] **Step 6: Create the registry**

For each `IconName`, open `design-system/node_modules/lucide-static/icons/<slug>.svg`, take **only the inner markup** (everything between `<svg …>` and `</svg>`), collapse to one line, and use it as the value. Do **not** hand-edit path data. The simple icons below are shown verbatim as the copy template; copy the rest the same way.

`design-system/src/components/graphics/Icon/icons.ts`:
```ts
// Icon artwork vendored from Lucide (ISC) — see ./LUCIDE-LICENSE.
// Source: lucide-static@<PINNED_VERSION>, icons/<slug>.svg, inner markup only.
// To update: re-copy from the pinned package. Do not hand-edit path data.
export type IconName =
  | "plus" | "folder-plus" | "info" | "chevron-right" | "chevron-down"
  | "close" | "edit" | "settings" | "warning" | "sun" | "moon" | "link"
  | "file-text" | "bar-chart" | "palette" | "puzzle" | "library" | "keyboard"
  | "hash" | "command";

export const ICONS: Record<IconName, string> = {
  // shown verbatim (copy template):
  "plus": `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
  "close": `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  "hash": `<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>`,
  // copied from node_modules/lucide-static/icons/<slug>.svg (inner markup):
  "folder-plus": `<!-- slug: folder-plus -->`,
  "info": `<!-- slug: info -->`,
  "edit": `<!-- slug: pencil -->`,
  "settings": `<!-- slug: settings -->`,
  "warning": `<!-- slug: triangle-alert -->`,
  "sun": `<!-- slug: sun -->`,
  "moon": `<!-- slug: moon -->`,
  "link": `<!-- slug: link -->`,
  "file-text": `<!-- slug: file-text -->`,
  "bar-chart": `<!-- slug: bar-chart-3 -->`,
  "palette": `<!-- slug: palette -->`,
  "puzzle": `<!-- slug: puzzle -->`,
  "library": `<!-- slug: library -->`,
  "keyboard": `<!-- slug: keyboard -->`,
  "command": `<!-- slug: command -->`,
};
```
Replace every `<!-- slug: … -->` placeholder with the copied inner markup before proceeding — the test's "non-empty SVG geometry" assertion (Step 1) fails until each is real markup, which is the guard that none were missed.

- [ ] **Step 7: Run test to verify it passes**

Run: `cd ui && npx vitest run src/ds-icon-registry.test.ts`
Expected: PASS (both assertions). If "non-empty SVG geometry" fails, a placeholder was left un-copied.

- [ ] **Step 8: Commit**

```bash
git add design-system/src/components/graphics/svg.ts \
        design-system/src/components/graphics/Icon/icons.ts \
        design-system/src/components/graphics/Icon/LUCIDE-LICENSE \
        design-system/package.json design-system/package-lock.json \
        ui/src/ds-icon-registry.test.ts
git commit -m "feat(design-system): vendor Lucide icon registry + shared SVG invariants"
```

---

## Task 2: Icon component

**Files:**
- Create: `design-system/src/components/graphics/Icon/Icon.tsx`
- Create: `design-system/src/components/graphics/Icon/Icon.css`
- Test: `ui/src/ds-icon-render.test.tsx`

**Interfaces:**
- Consumes: `ICONS`, `IconName` (Task 1); `SVG_INVARIANTS` (Task 1).
- Produces: default export `Icon` with props `{ name: IconName; size?: number; title?: string; ariaLabel?: string; class?: string; style?: JSX.CSSProperties | string }`, and a re-exported `type IconName`. Default size 16. Decorative (`aria-hidden="true"`) unless `title`/`ariaLabel` is set, in which case `role="img"` + `aria-label`.

- [ ] **Step 1: Write the failing test**

`ui/src/ds-icon-render.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import Icon from "@ds/components/graphics/Icon/Icon";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host.querySelector("svg")!;
}

describe("Icon", () => {
  it("defaults to 16px and is decorative when unlabeled", () => {
    const svg = mount(() => <Icon name="plus" />);
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });

  it("honors an explicit size", () => {
    const svg = mount(() => <Icon name="warning" size={20} />);
    expect(svg.getAttribute("width")).toBe("20");
  });

  it("is announced when labeled", () => {
    const svg = mount(() => <Icon name="info" ariaLabel="Details" />);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Details");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/ds-icon-render.test.tsx`
Expected: FAIL — cannot resolve `@ds/components/graphics/Icon/Icon`.

- [ ] **Step 3: Write the component**

`design-system/src/components/graphics/Icon/Icon.tsx`:
```tsx
import type { JSX } from "solid-js";
import { ICONS, type IconName } from "./icons";
import { SVG_INVARIANTS } from "../svg";
import "./Icon.css";

export type { IconName };

export interface IconProps {
  name: IconName;
  size?: number;
  /** When set, the icon is announced (role="img" + aria-label). */
  title?: string;
  ariaLabel?: string;
  class?: string;
  style?: JSX.CSSProperties | string;
}

const Icon = (props: IconProps) => {
  const size = () => props.size ?? 16;
  const label = () => props.ariaLabel ?? props.title;
  return (
    <svg
      class={`ds-icon${props.class ? ` ${props.class}` : ""}`}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      stroke-width="2"
      {...SVG_INVARIANTS}
      role={label() ? "img" : undefined}
      aria-label={label() || undefined}
      aria-hidden={label() ? undefined : "true"}
      style={props.style}
      innerHTML={ICONS[props.name]}
    />
  );
};

export default Icon;
```
> Note: `stroke-width="2"` on Lucide's 24 viewBox rendered at 16px yields an effective ~1.33px stroke — matching `FileIcon`'s 1.3. The accessible name uses `aria-label` (more reliable across AT than an SVG `<title>`); this is a deliberate, better refinement of the spec's "role=img + `<title>`".

- [ ] **Step 4: Write the CSS (self-contained)**

`design-system/src/components/graphics/Icon/Icon.css`:
```css
.ds-icon {
  display: inline-block;
  flex: none;          /* never shrink inside a flex row */
  vertical-align: middle;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && npx vitest run src/ds-icon-render.test.tsx`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add design-system/src/components/graphics/Icon/Icon.tsx \
        design-system/src/components/graphics/Icon/Icon.css \
        ui/src/ds-icon-render.test.tsx
git commit -m "feat(design-system): add Icon component over the vendored registry"
```

---

## Task 3: SegmentedControl icon-label extension (additive)

**Files:**
- Modify: `design-system/src/components/forms/SegmentedControl/SegmentedControl.tsx`
- Test: `ui/src/ds-segmented-icon.test.tsx`

**Interfaces:**
- Consumes: `Icon`, `IconName` (Task 2).
- Produces: `SegmentedOption` gains optional `icon?: IconName`. When present, an `<Icon>` renders before the label text. Absent → unchanged prior render.

- [ ] **Step 1: Write the failing test**

`ui/src/ds-segmented-icon.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

describe("SegmentedControl icon option", () => {
  it("renders an icon before the label when icon is set", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <SegmentedControl
          options={[{ label: "dark", value: "dark", icon: "moon" }]}
          value="dark"
          onChange={() => {}}
        />
      ),
      host,
    );
    expect(host.querySelector("svg.ds-icon")).not.toBeNull();
    expect(host.textContent).toContain("dark");
  });

  it("renders no icon when icon is absent (prior behavior)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <SegmentedControl
          options={[{ label: "light", value: "light" }]}
          value="light"
          onChange={() => {}}
        />
      ),
      host,
    );
    expect(host.querySelector("svg.ds-icon")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/ds-segmented-icon.test.tsx`
Expected: FAIL — `icon` is not an accepted option field / no `svg.ds-icon` rendered.

- [ ] **Step 3: Extend the component**

In `design-system/src/components/forms/SegmentedControl/SegmentedControl.tsx`:
1. Add the import at the top: `import Icon, { type IconName } from "../../graphics/Icon/Icon";`
2. Add `icon?: IconName;` to the `SegmentedOption` interface (after `label: string;`).
3. In the option render (currently `{option.label}`), place an icon before the label:
```tsx
<Show when={option.icon}>
  <Icon name={option.icon!} size={14} />
</Show>
{option.label}
```
Ensure `Show` is imported from `solid-js` (add to the existing import if absent). The button already lays its children in a row; if label and icon need spacing, add `gap` to the existing button style rule in `SegmentedControl.css` (do not introduce a new class).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/ds-segmented-icon.test.tsx`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add design-system/src/components/forms/SegmentedControl/SegmentedControl.tsx \
        design-system/src/components/forms/SegmentedControl/SegmentedControl.css \
        ui/src/ds-segmented-icon.test.tsx
git commit -m "feat(design-system): SegmentedControl optional per-option icon"
```

---

## Task 4: Gallery Icons showcase

**Files:**
- Modify: `design-system/src/screens/Gallery/Gallery.tsx` (+ `Gallery.css` if needed)

**Interfaces:**
- Consumes: `Icon`, `IconName` (Task 2). No exports.

> Verified by eye in the DS playground (`cd design-system && npm run dev`) under all three themes. Not gate-covered until Task 9 adds the DS tsc step (which will then type-check this file).

- [ ] **Step 1: Add the showcase section**

In `design-system/src/screens/Gallery/Gallery.tsx`, add near the other component sections:
```tsx
import Icon, { type IconName } from "../../components/graphics/Icon/Icon";

const ALL_ICONS: IconName[] = [
  "plus", "folder-plus", "info", "chevron-right", "chevron-down",
  "close", "edit", "settings", "warning", "sun", "moon", "link",
  "file-text", "bar-chart", "palette", "puzzle", "library", "keyboard",
  "hash", "command",
];
```
And in the JSX, a labeled grid:
```tsx
<section>
  <h2>Icons</h2>
  <div class="icon-gallery">
    <For each={ALL_ICONS}>
      {(n) => (
        <div class="icon-gallery__cell">
          <Icon name={n} size={20} />
          <code>{n}</code>
        </div>
      )}
    </For>
  </div>
</section>
```
(`For` is already imported in Gallery; if not, add it from `solid-js`.)

- [ ] **Step 2: Add grid CSS**

`design-system/src/screens/Gallery/Gallery.css` (append):
```css
.icon-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
  gap: var(--space-3);
}
.icon-gallery__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  color: var(--c-fg-primary);
}
```

- [ ] **Step 3: Verify in the playground**

Run: `cd design-system && npm run dev`, open the Gallery, confirm all 20 icons render, are visually consistent, and toggle correctly across light/dark/high-contrast via the Gallery theme switcher. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add design-system/src/screens/Gallery/Gallery.tsx design-system/src/screens/Gallery/Gallery.css
git commit -m "feat(design-system): Gallery Icons showcase"
```

---

## Task 5: Adopt Icon in App.tsx

**Files:**
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `Icon`, `IconName` (Task 2); `SegmentedControl` `icon?` (Task 3).

- [ ] **Step 1: Add the import**

At the top of `ui/src/App.tsx` (with the other `@ds` imports):
```tsx
import Icon, { type IconName } from "@ds/components/graphics/Icon/Icon";
```

- [ ] **Step 2: Swap the tree-header glyphs**

The "New file" `IconButton` child `＋` → `<Icon name="plus" />`; the "New folder" `IconButton` child `🗀` → `<Icon name="folder-plus" />`. (Both keep their `IconButton` + `label`.)

- [ ] **Step 3: Swap the set-info glyph (keep the bespoke button)**

In the `<button class="set-info-btn">…</button>`, replace the `ⓘ` child with `<Icon name="info" />`. Do **not** convert the button to `IconButton`.

- [ ] **Step 4: Swap the tree-row disclosure**

`{row.collapsed ? "▸" : "▾"}` → `<Icon name={row.collapsed ? "chevron-right" : "chevron-down"} size={14} />`.

- [ ] **Step 5: Swap the vault-switcher caret**

Inside `<span class="vault-btn__caret">`, replace `⌄` with `<Icon name="chevron-down" size={14} />`.

- [ ] **Step 6: Swap the Settings gear**

Replace the standalone `⚙` (the Settings trigger, ~line 2207) with `<Icon name="settings" />`.

- [ ] **Step 7: Convert the theme map to IconNames and use SegmentedControl's `icon`**

Replace the `THEME_ICON` glyph map:
```tsx
const THEME_ICON: Record<ThemeMode, IconName> = {
  system: "settings",
  light: "sun",
  dark: "moon",
};
```
And change the theme picker's options map from the embedded-glyph label to the `icon` field:
```tsx
options={(["system", "light", "dark"] as ThemeMode[]).map((m) => ({
  label: m,
  value: m,
  icon: THEME_ICON[m],
}))}
```

- [ ] **Step 8: Swap the settings-nav emoji for icons**

Restructure the nav list to carry an `icon` and render it before the label:
```tsx
each={
  [
    { id: "appearance", icon: "palette", label: "Appearance" },
    { id: "editor", icon: "file-text", label: "Editor" },
    { id: "wikilinks", icon: "link", label: "Wiki links" },
    { id: "plugins", icon: "puzzle", label: "Plugins" },
    { id: "statusbar", icon: "bar-chart", label: "Status bar" },
    { id: "vault", icon: "library", label: "Vault" },
    { id: "shortcuts", icon: "keyboard", label: "Shortcuts" },
  ] as { id: SettingsTab; icon: IconName; label: string }[]
}
```
And in the `modal__navitem` button body, replace `{t.label}` with:
```tsx
<Icon name={t.icon} size={16} />
{t.label}
```
If the label and icon need spacing, add `display:flex; align-items:center; gap:var(--space-2);` to the existing `.modal__navitem` rule in the app CSS (`ui/src/styles/layout.css`) — do not add a new class.

- [ ] **Step 9: Swap the settings-modal close + warning glyphs**

The settings-modal close `IconButton` child `✕` → `<Icon name="close" />`. The `⚠` warning (~line 2131) → `<Icon name="warning" />`.

- [ ] **Step 10: Verify tsc + tests + build**

Run: `cd ui && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean, all vitest green, build succeeds.

- [ ] **Step 11: Commit**

```bash
git add ui/src/App.tsx ui/src/styles/layout.css
git commit -m "feat(ui): adopt DS Icon across App shell (tree, settings, theme, vault)"
```

---

## Task 6: Adopt Icon in Properties.tsx + ChipList.tsx

**Files:**
- Modify: `ui/src/Properties.tsx`, `ui/src/properties/ChipList.tsx`

**Interfaces:**
- Consumes: `Icon` (Task 2).

- [ ] **Step 1: Adopt in Properties.tsx**

Add `import Icon from "@ds/components/graphics/Icon/Icon";`. Then:
- The family disclosure `{props.openFamily === family.label ? "▾" : "▸"}` → `<Icon name={props.openFamily === family.label ? "chevron-down" : "chevron-right"} size={14} />`.
- The other family/header `▾` (~line 397) → `<Icon name="chevron-down" size={14} />`.
- The `⚠` warning (~line 365) → `<Icon name="warning" size={14} />`.

- [ ] **Step 2: Adopt in ChipList.tsx**

Add `import Icon from "@ds/components/graphics/Icon/Icon";`. Then, inside the existing `IconButton`s:
- Edit button child `✎` → `<Icon name="edit" />`.
- Remove button child `×` → `<Icon name="close" />`.

- [ ] **Step 3: Verify tsc + tests + build**

Run: `cd ui && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add ui/src/Properties.tsx ui/src/properties/ChipList.tsx
git commit -m "feat(ui): adopt DS Icon in Properties + ChipList"
```

---

## Task 7: Adopt Icon in OmniBar.tsx

**Files:**
- Modify: `ui/src/omnibar/OmniBar.tsx`

**Interfaces:**
- Consumes: `Icon`, `IconName` (Task 2). OmniBar stays bespoke — glyph swap only.

- [ ] **Step 1: Swap the result-kind glyphs**

Add `import Icon, { type IconName } from "@ds/components/graphics/Icon/Icon";`. Replace the kind-glyph expression (`props.ranked.item.kind === "tag" ? "#" : … "⚡" : "◧"`) with an `<Icon>`:
```tsx
<Icon
  name={
    props.ranked.item.kind === "tag"
      ? "hash"
      : props.ranked.item.kind === "command"
        ? "command"
        : "file-text"
  }
  size={13}
/>
```
Keep the surrounding `<span>` (its color/size styling still positions the badge).

- [ ] **Step 2: Verify tsc + tests + build**

Run: `cd ui && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add ui/src/omnibar/OmniBar.tsx
git commit -m "feat(ui): adopt DS Icon for OmniBar result kinds"
```

---

## Task 8: Iconography note in the DS README

**Files:**
- Modify: `design-system/README.md`

- [ ] **Step 1: Add the section**

Add an **Iconography** subsection to `design-system/README.md` (after "Components"):
```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add design-system/README.md
git commit -m "docs(design-system): document iconography conventions"
```

---

## Task 9: Gate-harden (DS tsc) + share invariants in CubeMark/FileIcon

**Files:**
- Modify: `scripts/check.sh`
- Modify: `design-system/src/components/brand/CubeMark/CubeMark.tsx`, `design-system/src/components/data/FileTreeRow/FileIcon.tsx`

**Interfaces:**
- Consumes: `SVG_INVARIANTS` (Task 1).

- [ ] **Step 1: Add a design-system tsc gate**

In `scripts/check.sh`, after the existing `==> tsc` line for `ui`, add:
```sh
echo "==> tsc (design-system)"; ( cd design-system && npx tsc --noEmit )
```
This type-checks DS-only files (Gallery, screens, CubeMark/FileIcon) that `ui`'s tsc never sees.

- [ ] **Step 2: Run it — triage any pre-existing DS type errors**

Run: `cd design-system && npx tsc --noEmit`
Expected: clean. If it surfaces **pre-existing** errors unrelated to this work, do not fix them here — revert Step 1, note the finding for a separate issue, and skip to Step 5 (the gate-hardening is optional; the rest of the plan stands without it).

- [ ] **Step 3: Share invariants in CubeMark**

In `CubeMark.tsx`, import `import { SVG_INVARIANTS } from "../../graphics/svg";` and replace the literal `fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"` attrs with `{...SVG_INVARIANTS}` (keep its own `viewBox="0 0 24 24"` and `stroke-width="1.6"`). No visual change.

- [ ] **Step 4: Share invariants in FileIcon**

In `FileIcon.tsx`, import `SVG_INVARIANTS` from `../../graphics/svg` and fold the shared keys into the `common` object (keep `width/height/viewBox: "0 0 16 16"` and `stroke-width: 1.3`):
```tsx
const common = { width: 16, height: 16, viewBox: "0 0 16 16", "stroke-width": 1.3, ...SVG_INVARIANTS };
```
No visual change.

- [ ] **Step 5: Verify**

Run: `cd design-system && npx tsc --noEmit`
Expected: clean. Then spot-check CubeMark + a file icon in the playground (`npm run dev`) look identical to before.

- [ ] **Step 6: Commit**

```bash
git add scripts/check.sh design-system/src/components/brand/CubeMark/CubeMark.tsx \
        design-system/src/components/data/FileTreeRow/FileIcon.tsx
git commit -m "chore(design-system): gate DS tsc + share SVG invariants in CubeMark/FileIcon"
```

---

## Task 10: Full gate + live smoke (acceptance)

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `scripts/check.sh`
Expected: green — tsc (ui + design-system), vitest (ui, incl. the 3 new tests), build, cargo fmt/clippy/test, docs. The only tolerated red line is the documented `watcher::…within_100ms` flake (confirm it passes in isolation if it appears).

- [ ] **Step 2: Live smoke under the real backend**

Follow the `project-tauri-live-verify-setup` memory. Run `cargo tauri dev` against `feature-test-vault` and confirm every adopted site renders as a crisp icon, not a glyph:
- Tree header: `plus` / `folder-plus`.
- File tree: row disclosure chevrons collapse/expand.
- Properties (`concepts/Properties.md`): family chevrons, the `warning` on a lossy value, ChipList `edit`/`close`.
- Settings modal: nav icons (palette/file-text/link/puzzle/bar-chart/library/keyboard), the `settings` gear, the theme picker showing real `sun`/`moon`/`settings`, the close `close`.
- Vault switcher caret; OmniBar (`Cmd+K`) result-kind icons.
Capture a screenshot as proof. Confirm the vault is byte-for-byte unchanged (md5 before == after).

- [ ] **Step 3: Size tuning (if needed)**

If any adopted icon reads too large/small next to its old glyph, adjust the `size` prop at that call site only (default 16; chevrons/badges typically 13–14), re-run `scripts/check.sh`, and re-verify.

- [ ] **Step 4: Final commit (if Step 3 changed anything)**

```bash
git add -A && git commit -m "fix(ui): tune adopted icon sizes from live smoke"
```

---

## Self-Review

- **Spec coverage:** Icon component (T2) ✅, vendored Lucide registry + license (T1) ✅, `graphics/` category + shared `svg.ts` (T1/T9) ✅, full icon set mapped (T1 + reference table) ✅, adoption across App/Properties/ChipList/OmniBar (T5–T7) ✅, bespoke surfaces glyph-only (T5 set-info, T7 OmniBar) ✅, Gallery showcase (T4) ✅, Iconography doc (T8) ✅, tests in ui suite/node+jsdom reality (T1–T3) ✅, DS-tsc gate hole (T9) ✅, live smoke + byte-for-byte vault (T10) ✅. The spec's theme-picker string-label blocker is resolved by the T3 `SegmentedControl` extension (approved scope addition).
- **Placeholders:** the only intentional fill-ins are the vendored icon markup (`<!-- slug: … -->`), which the registry test (T1 "non-empty SVG geometry") forces to be replaced — that's a guard, not a placeholder gap. `<PINNED_VERSION>` is filled from `npm ls` in T1 Step 3.
- **Type consistency:** `IconName` defined in `icons.ts` (T1), re-exported from `Icon.tsx` (T2), consumed by `SegmentedOption.icon` (T3) and every adopter (T5–T7) via the same `@ds/components/graphics/Icon/Icon` import. `ICONS` and `SVG_INVARIANTS` names consistent across T1/T2/T9. Theme/kind → IconName mappings match the reference table.
