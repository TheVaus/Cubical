# Settings Info Popovers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ⓘ` button beside the toggle of each *complex* setting that opens a small inline popover explaining the feature (with a minimal example for the data-ish ones).

**Architecture:** A single `openInfo` signal in `App` tracks which popover is open; a pure `toggleInfo` reducer (extracted to its own module, the only unit-tested piece — this codebase tests logic, never rendered components) drives open/close/switch. Four rows (Typed properties, Wiki-link repair, Dataview, Property references) gain an `ⓘ` button and an absolutely-positioned `.set-info-pop` anchored below it, closed by a shared transparent backdrop. The existing inline Typed-properties "how it works" block moves verbatim into its popover.

**Tech Stack:** Solid-JS + TypeScript, Vitest (logic only — no component render library), plain CSS in `ui/src/styles/layout.css`. Tauri webview for manual/preview verification.

## Global Constraints

- Only the four named settings get an `ⓘ`; simple rows (Theme, Show status bar, raw-source default, status-bar segments, currency/date/tags rows) get none. (Verbatim from spec "Which settings get the button".)
- Popover ids are exactly: `typed-props`, `wiki-repair`, `dataview`, `property-refs`. (Verbatim from spec table.)
- One popover open at a time (single `string | null` signal). (Spec "State".)
- No new component-render test dependency; unit-test only the extracted reducer. Match the `Toast.tsx` / `toastState.ts` split convention.
- All CSS uses existing design tokens (`--space-*`, `--text-xs`, `--radius-md`, `--shadow-md`, `--c-bg-primary`, `--c-border-subtle`, `--c-fg-muted`, `--c-fg-secondary`, `--c-accent`). No new tokens.
- Gates must stay green: `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs).

---

### Task 1: Extract the info-popover toggle reducer

**Files:**
- Create: `ui/src/settings/settingsInfo.ts`
- Test: `ui/src/settings/settingsInfo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type InfoId = "typed-props" | "wiki-repair" | "dataview" | "property-refs"`
  - `toggleInfo(current: InfoId | null, id: InfoId): InfoId | null` — returns `null` if `current === id` (clicking the open row closes it), else returns `id` (open/switch).

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/settings/settingsInfo.test.ts
import { describe, expect, it } from "vitest";

import { toggleInfo, type InfoId } from "./settingsInfo";

describe("toggleInfo", () => {
  it("opens a popover from the closed state", () => {
    expect(toggleInfo(null, "dataview")).toBe("dataview");
  });

  it("closes when the same id is clicked again", () => {
    expect(toggleInfo("dataview", "dataview")).toBeNull();
  });

  it("switches directly from one popover to another", () => {
    const next: InfoId | null = toggleInfo("dataview", "typed-props");
    expect(next).toBe("typed-props");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/settings/settingsInfo.test.ts`
Expected: FAIL — cannot resolve module `./settingsInfo`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/settings/settingsInfo.ts

/** Settings whose toggle carries an info popover (spec: four complex settings). */
export type InfoId = "typed-props" | "wiki-repair" | "dataview" | "property-refs";

/**
 * Reducer for the single `openInfo` signal. Clicking the `ⓘ` of the
 * already-open row closes it; any other click opens (or switches to) that row.
 */
export function toggleInfo(current: InfoId | null, id: InfoId): InfoId | null {
  return current === id ? null : id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/settings/settingsInfo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/settingsInfo.ts ui/src/settings/settingsInfo.test.ts
git commit -m "feat(settings): add info-popover toggle reducer"
```

---

### Task 2: Add popover CSS

**Files:**
- Modify: `ui/src/styles/layout.css` (insert after the `.set-row__desc` block, ~line 543)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS classes `.set-row__control`, `.set-info-btn`, `.set-info-pop`, `.set-info-backdrop` used by Task 3's markup.

- [ ] **Step 1: Add the CSS block**

Insert immediately after the existing `.set-row__desc { … }` rule:

```css
.set-row__control {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.set-info-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--c-fg-muted);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition-fast);
}
.set-info-btn:hover {
  color: var(--c-accent);
}
.set-info-pop {
  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  z-index: 20;
  width: max-content;
  max-width: 320px;
  padding: var(--space-3);
  background: var(--c-bg-primary);
  border: 1px solid var(--c-border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  color: var(--c-fg-secondary);
  font-size: var(--text-xs);
  text-align: left;
}
.set-info-pop p {
  margin: 0 0 var(--space-2);
}
.set-info-pop p:last-child {
  margin-bottom: 0;
}
.set-info-pop pre {
  margin: 0 0 var(--space-2);
  padding: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--c-bg-primary);
  border: 1px solid var(--c-border-subtle);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
}
.set-info-pop code {
  font-family: var(--font-mono);
}
.set-info-backdrop {
  position: fixed;
  inset: 0;
  z-index: 19;
  background: transparent;
}
```

- [ ] **Step 2: Verify CSS compiles via the typecheck/build gate**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: build succeeds (CSS is bundled; no errors).

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles/layout.css
git commit -m "feat(settings): style info-popover button and panel"
```

---

### Task 3: Wire the button + popovers into the settings modal

**Files:**
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `toggleInfo`, `InfoId` from Task 1; CSS classes from Task 2.
- Produces: the rendered `ⓘ` buttons + popovers (terminal UI; nothing downstream consumes it).

- [ ] **Step 1: Import the reducer**

Add to the existing import block that pulls from `./settings/corePlugins` (App.tsx ~line 107), as a separate import line:

```tsx
import { toggleInfo, type InfoId } from "./settings/settingsInfo";
```

- [ ] **Step 2: Add the signal**

Next to the existing `settingsTab` signal (App.tsx ~line 340), add:

```tsx
const [openInfo, setOpenInfo] = createSignal<InfoId | null>(null);
const flipInfo = (id: InfoId) => setOpenInfo((cur) => toggleInfo(cur, id));
```

- [ ] **Step 3: Clear the popover when the modal closes or the tab changes**

In every place that closes the modal — the backdrop `onClick` (App.tsx ~line 2007) and the close-button `onClick` (~line 2014) — replace `onClick={() => setSettingsOpen(false)}` with:

```tsx
onClick={() => {
  setSettingsOpen(false);
  setOpenInfo(null);
}}
```

In the nav tab button (App.tsx ~line 2040), replace `onClick={() => setSettingsTab(t.id)}` with:

```tsx
onClick={() => {
  setSettingsTab(t.id);
  setOpenInfo(null);
}}
```

- [ ] **Step 4: Add a reusable info-button + backdrop snippet near the modal body**

Define a local helper component just above the `return (` of `App` (App.tsx ~line 1400), so each of the four rows stays terse:

```tsx
  /** `ⓘ` button + its popover, anchored inside a `.set-row__control`. */
  const InfoButton = (props: { id: InfoId; children: JSXElement }) => (
    <>
      <button
        type="button"
        class="set-info-btn"
        aria-label="About this setting"
        aria-expanded={openInfo() === props.id}
        onClick={() => flipInfo(props.id)}
      >
        ⓘ
      </button>
      <Show when={openInfo() === props.id}>
        <div class="set-info-pop" role="dialog" aria-label="Setting help">
          {props.children}
        </div>
      </Show>
    </>
  );
```

Add `JSXElement` to the `solid-js` type import at the top of the file (App.tsx line 1-11):

```tsx
  type JSXElement,
```

- [ ] **Step 5: Add the shared backdrop**

Immediately inside the `<div class="modal" …>` (App.tsx ~line 2009), as its first child, add:

```tsx
<Show when={openInfo() !== null}>
  <div class="set-info-backdrop" onClick={() => setOpenInfo(null)} />
</Show>
```

- [ ] **Step 6: Wrap the Dataview row's control and add its popover**

In the Plugins `<For each={CORE_PLUGINS}>` block (App.tsx ~2345), the generic row renders the same `seg-control` for every plugin. Replace the plugin row's `<div class="seg-control">…</div>` wrapper with a `.set-row__control` that conditionally shows an `InfoButton` for the two plugins that have one:

```tsx
<div class="set-row__control">
  <Show when={p.id === "dataview"}>
    <InfoButton id="dataview">
      <p>
        A <code>query</code> block renders live results from your vault as a
        table, list, or count — it updates as notes change.
      </p>
      <pre>{"```query\nfrom #project where status = \"active\"\n```"}</pre>
    </InfoButton>
  </Show>
  <Show when={p.id === "property-refs"}>
    <InfoButton id="property-refs">
      <p>
        <code>[[note.prop]]</code> shows a value from another note's
        frontmatter inline; <code>[[.prop]]</code> reads the current note's own.
      </p>
      <pre>{"# In Ann.md\n---\nrole: Engineer\n---\n\n# In any note\nAnn is a [[Ann.role]]."}</pre>
    </InfoButton>
  </Show>
  <div class="seg-control">
    {/* existing Off / On buttons unchanged */}
  </div>
</div>
```

(Keep the existing Off/On `<button>`s verbatim inside `.seg-control`.)

- [ ] **Step 7: Wrap the Wiki-links row's control and add its popover**

In the Wiki links tab, the "Repair broken links on rename" row (App.tsx ~2307). Wrap its `<div class="seg-control">` in a `.set-row__control` and prepend:

```tsx
<InfoButton id="wiki-repair">
  <p>
    <strong>On:</strong> renaming a file also fixes links that point at its
    old name but had already broken from an earlier rename.
  </p>
  <p>
    <strong>Off:</strong> a rename only updates links that still resolve to
    the file.
  </p>
</InfoButton>
```

- [ ] **Step 8: Wrap the Typed-properties row's control and add its popover (move the inline block)**

In the Editor tab, the "Typed properties" row (App.tsx ~2105). Wrap its `<div class="seg-control">` in a `.set-row__control` and prepend `<InfoButton id="typed-props">…</InfoButton>`. Move the **entire** existing "how it works" block — the `<div class="set-row__desc" style={{ "margin-top": "var(--space-2)" }}>…</div>` currently inside `<Show when={typedProps()}>` (App.tsx ~2204–2302) — into the `InfoButton`'s children. Drop its outer `set-row__desc`/inline-`margin-top` wrapper (the `.set-info-pop` now provides padding); keep the inner `<p>`, the token-grid `<For>`, the example `<pre>`, and trailing `<p>` exactly as written.

After the move, the `<Show when={typedProps()}>` block contains only the date-format, currency, and "Render tags as tags" rows.

```tsx
<div class="set-row__control">
  <InfoButton id="typed-props">
    {/* moved how-it-works content: intro <p>, token grid <For>, example <pre>, trailing <p> */}
  </InfoButton>
  <div class="seg-control">
    {/* existing typed-props Off / On buttons unchanged */}
  </div>
</div>
```

- [ ] **Step 9: Typecheck, build, and run the full vitest suite**

Run: `cd ui && npx tsc --noEmit && npm run build && npx vitest run`
Expected: tsc clean, build succeeds, all vitest pass (including Task 1's 3 new tests).

- [ ] **Step 10: Preview-verify the four popovers**

Start the dev server and, in Settings, open each tab and confirm: the `ⓘ` sits left of the Off/On toggle on exactly the four rows; clicking it opens a readable popover anchored below-right that does not overflow the modal; clicking the same `ⓘ` or anywhere outside closes it; switching tabs closes any open popover. Check in both light and dark themes. Capture a screenshot of one open popover (e.g. Dataview) as proof.

- [ ] **Step 11: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(settings): add ⓘ info popovers to complex settings"
```

---

### Task 4: Final gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full repo gate**

Run: `scripts/check.sh`
Expected: all green (fmt/clippy/test, tsc, vitest, build, docs).

- [ ] **Step 2: If green, no commit needed** — Tasks 1–3 already committed their deliverables.

---

## Self-Review

**Spec coverage:**
- "Which settings get the button" (4 rows) → Tasks 3 steps 6–8 + Global Constraints. ✓
- State (single `string | null` signal, toggle, reset on close/tab) → Task 1 + Task 3 steps 2–3. ✓
- Layout & markup (`.set-row__control`, `ⓘ`, anchored popover, shared backdrop) → Task 2 + Task 3 steps 4–5. ✓
- CSS classes/tokens → Task 2. ✓
- Popover content (4 features, examples) → Task 3 steps 6–8. ✓
- Typed-properties block *moved* (not duplicated), date/currency/tags rows stay → Task 3 step 8. ✓
- Testing (toggle open/close/switch as logic; anchoring/overflow/theme via preview) → Task 1 tests + Task 3 step 10. ✓

**Placeholder scan:** No TBD/TODO; the only "{/* … unchanged */}" markers point at verbatim-preserved existing JSX, which is the intended DRY instruction, not a gap. ✓

**Type consistency:** `InfoId` and `toggleInfo` signatures identical across Tasks 1 and 3; signal typed `InfoId | null`; `flipInfo`/`openInfo`/`setOpenInfo` names consistent. ✓
