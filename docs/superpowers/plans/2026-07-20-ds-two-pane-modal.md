# DS Two-Pane Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `TwoPaneModal` primitive in the design system (nav + body) and adopt it for the app's bespoke Settings modal — the 6th of the 7 issue-#35 primitives.

**Architecture:** A standalone DS component that renders its own overlay shell (Portal + scrim + Escape + click-outside + `role="dialog"` panel) plus a two-pane grid: a left nav the DS renders from a structured `items` prop, and a right body slot the app fills. The live single-column `Modal` is deliberately **not** touched. The Settings *shell* CSS moves out of `ui/src/styles/layout.css` into the component; the settings *body* content stays app-owned.

**Tech Stack:** SolidJS + TypeScript, Vite, vitest (jsdom), plain CSS with design tokens.

## Global Constraints

- **DS components must be self-contained.** A DS component may not depend on the playground's `base.css` control reset or `layout.css` utilities — set the control reset and layout in the component's own CSS. (Campaign load-bearing rule.)
- **Extend additively; never fork.** Do not modify `Modal`, `CommandPalette`, or any other existing DS component in this plan.
- **These are Solid components: never destructure props** (breaks reactivity).
- **CSS namespace:** new DS components use the `ds-` prefix (matches `ds-popover__*`). Do **not** reuse the app's `.modal*` names or the older `Modal`'s `.modal-scrim`/`.modal-panel`.
- **Escape handler must be active only while open** — gate it in a `createEffect` on `props.open` (this exact bug was fixed in Popover, commit `b38c979`). Do not use bare `onMount`.
- **Gate command:** `scripts/check.sh` (tsc for `ui` *and* `design-system`, vitest, build, cargo fmt/clippy/test, docs). Run the script, not the pieces.
- **Known flake, not yours:** `cubical-core`'s `watcher::…dropping_handle_stops_event_delivery_within_100ms` fails under full-workspace load and passes in isolation. Zero Rust is touched by this plan.
- **Test files live in `ui/src/ds-*.test.tsx`** (the app's vitest project), importing the component via the `@ds` alias — matching `ds-popover.test.tsx`.

---

### Task 1: Build the DS `TwoPaneModal` component

**Files:**
- Create: `design-system/src/components/overlay/TwoPaneModal/TwoPaneModal.tsx`
- Create: `design-system/src/components/overlay/TwoPaneModal/TwoPaneModal.css`
- Test: `ui/src/ds-two-pane-modal.test.tsx`

**Interfaces:**
- Consumes: `Icon` + `IconName` from `../../graphics/Icon/Icon`; `IconButton` from `../../forms/IconButton/IconButton`.
- Produces: default export `TwoPaneModal`; named exports `TwoPaneNavItem`, `TwoPaneModalProps`. Task 2 and Task 3 import it as
  `import TwoPaneModal from "@ds/components/overlay/TwoPaneModal/TwoPaneModal"` (app) or
  `from '../../components/overlay/TwoPaneModal/TwoPaneModal'` (Gallery).

**Note on Portal:** the component renders through Solid's `Portal`, so its DOM lands on `document.body`, **not** inside the test host element. Query with `document.querySelector`, not `host.querySelector`. (This is why the test below differs from `ds-popover.test.tsx`, which renders inline.)

- [ ] **Step 1: Write the failing test**

Create `ui/src/ds-two-pane-modal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import TwoPaneModal from "@ds/components/overlay/TwoPaneModal/TwoPaneModal";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

const ITEMS = [
  { id: "appearance", icon: "palette" as const, label: "Appearance" },
  { id: "editor", icon: "file-text" as const, label: "Editor" },
];

const panel = () => document.querySelector(".ds-two-pane-modal__panel");
const navItems = () =>
  Array.from(document.querySelectorAll(".ds-two-pane-modal__navitem"));

describe("TwoPaneModal", () => {
  it("renders nothing when open is false", () => {
    mount(() => (
      <TwoPaneModal
        open={false}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body content</p>
      </TwoPaneModal>
    ));
    expect(panel()).toBeNull();
    expect(document.querySelector(".ds-two-pane-modal__scrim")).toBeNull();
  });

  it("renders nav items, body, and dialog ARIA on the panel", () => {
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body content</p>
      </TwoPaneModal>
    ));
    const p = panel();
    expect(p).not.toBeNull();
    // ARIA lives on the PANEL, not the scrim (fixes the app's old bug).
    expect(p!.getAttribute("role")).toBe("dialog");
    expect(p!.getAttribute("aria-modal")).toBe("true");
    expect(p!.getAttribute("aria-label")).toBe("Settings");
    expect(document.querySelector(".ds-two-pane-modal__scrim")!.getAttribute("role")).toBeNull();
    expect(navItems().map((n) => n.textContent)).toEqual(["Appearance", "Editor"]);
    expect(document.querySelector(".ds-two-pane-modal__body")!.textContent).toContain("body content");
  });

  it("prefers ariaLabel over title for the accessible name", () => {
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        ariaLabel="App preferences"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    expect(panel()!.getAttribute("aria-label")).toBe("App preferences");
  });

  it("marks only the active nav item", () => {
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="editor"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    const [appearance, editor] = navItems();
    expect(editor.classList.contains("ds-two-pane-modal__navitem--active")).toBe(true);
    expect(editor.getAttribute("aria-current")).toBe("true");
    expect(appearance.classList.contains("ds-two-pane-modal__navitem--active")).toBe(false);
    expect(appearance.getAttribute("aria-current")).toBeNull();
  });

  it("calls onSelect with the item id when a nav item is clicked", () => {
    const onSelect = vi.fn();
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={onSelect}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    (navItems()[1] as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith("editor");
  });

  it("closes on scrim click but not on panel click", () => {
    const onClose = vi.fn();
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={onClose}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    (panel() as HTMLElement).click();
    expect(onClose).not.toHaveBeenCalled();
    (document.querySelector(".ds-two-pane-modal__scrim") as HTMLElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape while open, and detaches the handler once closed", () => {
    const onClose = vi.fn();
    const [open, setOpen] = createSignal(true);
    mount(() => (
      <TwoPaneModal
        open={open()}
        onClose={onClose}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    setOpen(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1); // no further calls once closed
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/ds-two-pane-modal.test.tsx`
Expected: FAIL — module not found, `Failed to resolve import "@ds/components/overlay/TwoPaneModal/TwoPaneModal"`.

- [ ] **Step 3: Write the component**

Create `design-system/src/components/overlay/TwoPaneModal/TwoPaneModal.tsx`:

```tsx
import { createEffect, For, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import Icon, { type IconName } from '../../graphics/Icon/Icon';
import IconButton from '../../forms/IconButton/IconButton';
import './TwoPaneModal.css';

export interface TwoPaneNavItem {
  id: string;
  /** DS icon rendered before the label. */
  icon?: IconName;
  label: string;
}

export interface TwoPaneModalProps {
  open: boolean;
  onClose: () => void;
  /** Nav header, e.g. "Settings". Also the default accessible name. */
  title: string;
  items: TwoPaneNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Panel accessible name; defaults to `title`. */
  ariaLabel?: string;
  /** Body content for the active pane — owned by the consumer. */
  children: JSX.Element;
}

/**
 * Two-pane modal: a fixed-size panel split into a left nav (rendered by this
 * component from `items`) and a right body slot the consumer fills.
 *
 * The consumer owns the body content and the active-pane state; this component
 * owns the overlay shell and the nav chrome. `role="dialog"`/`aria-modal` sit on
 * the panel (not the scrim). Escape and scrim click both close; clicks inside
 * the panel do not propagate to the scrim.
 *
 * Full APG tablist semantics (`role="tablist"` + roving tabindex) are
 * deliberately out of scope — the active item is announced via `aria-current`.
 */
const TwoPaneModal = (props: TwoPaneModalProps) => {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  // Active only while open — a bare onMount listener would fire when closed.
  createEffect(() => {
    if (!props.open) return;
    document.addEventListener('keydown', handleKey);
    onCleanup(() => document.removeEventListener('keydown', handleKey));
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div class="ds-two-pane-modal__scrim" onClick={() => props.onClose()}>
          <div
            class="ds-two-pane-modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={props.ariaLabel ?? props.title}
            onClick={(e) => e.stopPropagation()}
          >
            <span class="ds-two-pane-modal__close">
              <IconButton label={`Close ${props.title.toLowerCase()}`} onClick={() => props.onClose()}>
                <Icon name="close" />
              </IconButton>
            </span>
            <nav class="ds-two-pane-modal__nav">
              <h3 class="ds-two-pane-modal__navtitle">{props.title}</h3>
              <For each={props.items}>
                {(item) => (
                  <button
                    type="button"
                    class="ds-two-pane-modal__navitem"
                    classList={{
                      'ds-two-pane-modal__navitem--active': props.activeId === item.id,
                    }}
                    aria-current={props.activeId === item.id ? 'true' : undefined}
                    onClick={() => props.onSelect(item.id)}
                  >
                    <Show when={item.icon}>{(name) => <Icon name={name()} size={16} />}</Show>
                    {item.label}
                  </button>
                )}
              </For>
            </nav>
            <div class="ds-two-pane-modal__body">{props.children}</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default TwoPaneModal;
```

- [ ] **Step 4: Write the component CSS**

Create `design-system/src/components/overlay/TwoPaneModal/TwoPaneModal.css`. These rules are ported verbatim (values unchanged) from `ui/src/styles/layout.css` lines 438–510, renamed to the `ds-` namespace. `.ds-two-pane-modal__navitem` sets its own full control reset so the component does not depend on the playground's `base.css` button reset:

```css
.ds-two-pane-modal__scrim {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  /* modal scrim: a true dim for figure/ground separation (NOT --c-bg-overlay,
     which is a 5% subtle tint — and white-on-dark, the wrong direction). */
  background: rgba(0, 0, 0, 0.5);
}

.ds-two-pane-modal__panel {
  position: relative;
  width: min(40rem, 92vw);
  height: min(28rem, 84vh);
  display: flex;
  overflow: hidden;
  background: var(--c-bg-primary);
  border: 1px solid var(--c-border-subtle);
  border-radius: var(--radius-lg, var(--radius-md));
  box-shadow: var(--shadow-lg, var(--shadow-md));
}

.ds-two-pane-modal__close {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  z-index: 2;
}

.ds-two-pane-modal__nav {
  flex: 0 0 11rem;
  background: var(--c-bg-secondary);
  border-right: 1px solid var(--c-border-subtle);
  padding: var(--space-3) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ds-two-pane-modal__navtitle {
  margin: 0 var(--space-2) var(--space-2);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--c-fg-muted);
}

.ds-two-pane-modal__navitem {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  margin: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--c-fg-secondary);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.ds-two-pane-modal__navitem:hover {
  color: var(--c-fg-primary);
  background: var(--c-bg-tertiary);
}

.ds-two-pane-modal__navitem--active {
  color: var(--c-fg-inverse);
  background: var(--c-accent);
}

.ds-two-pane-modal__body {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: var(--space-5);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ui && npx vitest run src/ds-two-pane-modal.test.tsx`
Expected: PASS — 7 tests passing.

- [ ] **Step 6: Commit**

```bash
git add design-system/src/components/overlay/TwoPaneModal ui/src/ds-two-pane-modal.test.tsx
git commit -m "feat(design-system): add TwoPaneModal primitive (nav + body)"
```

---

### Task 2: Adopt `TwoPaneModal` for the Settings modal and migrate the CSS

**Files:**
- Modify: `ui/src/App.tsx` — shell at `2479-2491` and `2502-2535`, closers at `2915-2918`; `modal__h2` at `2537, 2557, 2758, 2791, 2836, 2878`
- Modify: `ui/src/settings/ShortcutsPanel.tsx:94` (`modal__h2` → `set-h2`)
- Modify: `ui/src/styles/layout.css` — delete `438-510`, rename `.modal__h2` (`511`) and `.modal kbd` (`661`)

**Interfaces:**
- Consumes: `TwoPaneModal` from Task 1 (`@ds/components/overlay/TwoPaneModal/TwoPaneModal`), props `open/onClose/title/items/activeId/onSelect/children`.
- Produces: nothing new for later tasks.

**Line numbers shift as you edit — match on the quoted code, not the number.**

- [ ] **Step 1: Add the import and hoist the tab list**

In `ui/src/App.tsx`, add next to the existing DS imports (near line 21, `import Modal from "@ds/components/overlay/Modal/Modal";`):

```tsx
import TwoPaneModal from "@ds/components/overlay/TwoPaneModal/TwoPaneModal";
```

Then add this module-level constant beside the other top-level consts (above the component function, after the imports). It is the same list currently inlined in the `<For>` at `2504-2515`:

```tsx
const SETTINGS_TABS: { id: SettingsTab; icon: IconName; label: string }[] = [
  { id: "appearance", icon: "palette", label: "Appearance" },
  { id: "editor", icon: "file-text", label: "Editor" },
  { id: "wikilinks", icon: "link", label: "Wiki links" },
  { id: "plugins", icon: "puzzle", label: "Plugins" },
  { id: "statusbar", icon: "bar-chart", label: "Status bar" },
  { id: "vault", icon: "library", label: "Vault" },
  { id: "shortcuts", icon: "keyboard", label: "Shortcuts" },
];
```

- [ ] **Step 2: Replace the opening shell**

Replace everything from `<Show when={settingsOpen()}>` (2479) through `<div class="modal__body">` (2535) — the scrim div, the `.modal` panel, the `.modal__close` span, the whole `<nav class="modal__nav">…</nav>`, and the body div — with:

```tsx
      <TwoPaneModal
        open={settingsOpen()}
        onClose={() => {
          setSettingsOpen(false);
          setOpenInfo(null);
        }}
        title="Settings"
        items={SETTINGS_TABS}
        activeId={settingsTab()}
        onSelect={(id) => {
          setSettingsTab(id as SettingsTab);
          setOpenInfo(null);
        }}
      >
```

The seven per-tab `<Show when={settingsTab() === "…"}>` blocks that followed are now the children and stay exactly as they are.

- [ ] **Step 3: Replace the closing shell**

At the end of the settings block (was 2915-2918), replace the three closing `</div>`s and the `</Show>`:

```tsx
            </div>
          </div>
        </div>
      </Show>
```

with a single closer:

```tsx
      </TwoPaneModal>
```

The preceding `</Show>` that closes the `shortcuts` tab block stays.

- [ ] **Step 4: Rename the body heading class (7 sites)**

`.modal__h2` is body content and stays app-owned, but must stop depending on the now-DS-internal `.modal` namespace. Rename all 7 usages to `set-h2`:

```bash
cd /Users/user/Developer/Cubical
sed -i '' 's/class="modal__h2"/class="set-h2"/g' ui/src/App.tsx ui/src/settings/ShortcutsPanel.tsx
grep -rn 'modal__h2' ui/src   # expect: no matches
```

- [ ] **Step 5: Migrate the CSS in `ui/src/styles/layout.css`**

Delete the shell rules that moved to the DS — everything from `.modal-backdrop {` (438) through the end of `.modal__body { … }` (510). Change the section comment on line 437 from `/* ---- settings modal ---- */` to `/* ---- settings body ---- */`, then rename the two survivors:

- `.modal__h2 {` → `.set-h2 {`
- `.modal kbd {` (661) → `.kb-row kbd {` — both `<kbd>` elements live inside `.kb-row` (`ShortcutsPanel.tsx:103` and `:107`), so this selector covers them without relying on a `.modal` ancestor.

Verify nothing app-side still references the removed names:

```bash
grep -rn 'modal-backdrop\|modal__\|\.modal ' ui/src   # expect: no matches
```

- [ ] **Step 6: Run the full gate**

Run: `scripts/check.sh`
Expected: PASS — tsc (`ui` + `design-system`), vitest (**764 baseline + the 7 new = 771**), build, cargo fmt/clippy/test, docs. The only acceptable red line is the documented `dropping_handle_stops_event_delivery_within_100ms` watcher flake.

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.tsx ui/src/settings/ShortcutsPanel.tsx ui/src/styles/layout.css
git commit -m "feat(ui): adopt DS TwoPaneModal for Settings, retire bespoke .modal shell"
```

---

### Task 3: Add `TwoPaneModal` to the DS Gallery

**Files:**
- Modify: `design-system/src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Consumes: `TwoPaneModal` from Task 1.
- Produces: nothing.

This matches the precedent set for Popover (commit `073f7c8`) — every DS component is showcased in the Gallery so the playground stays a complete roster.

- [ ] **Step 1: Add the import**

In `design-system/src/screens/Gallery/Gallery.tsx`, after the `Popover` import (line 22):

```tsx
import TwoPaneModal from '../../components/overlay/TwoPaneModal/TwoPaneModal';
```

- [ ] **Step 2: Add the state signals**

Beside the other overlay signals (next to `const [popoverOpen, setPopoverOpen] = createSignal(false);`):

```tsx
  const [twoPaneOpen, setTwoPaneOpen] = createSignal(false);
  const [twoPaneTab, setTwoPaneTab] = createSignal('appearance');
```

- [ ] **Step 3: Add the showcase section**

Add a new `<section>` after the `Overlay — Popover` section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Overlay — TwoPaneModal</div>
        <div class="gallery-row row">
          <Button variant="secondary" onClick={() => setTwoPaneOpen(true)}>
            Open two-pane modal
          </Button>
        </div>
        <TwoPaneModal
          open={twoPaneOpen()}
          onClose={() => setTwoPaneOpen(false)}
          title="Settings"
          items={[
            { id: 'appearance', icon: 'palette', label: 'Appearance' },
            { id: 'editor', icon: 'file-text', label: 'Editor' },
            { id: 'keyboard', icon: 'keyboard', label: 'Shortcuts' },
          ]}
          activeId={twoPaneTab()}
          onSelect={(id) => setTwoPaneTab(id)}
        >
          <h2>{twoPaneTab()}</h2>
          <p>Body content for the “{twoPaneTab()}” pane. The consumer owns this slot.</p>
        </TwoPaneModal>
      </section>
```

- [ ] **Step 4: Verify the design-system builds and type-checks**

Run: `scripts/check.sh`
Expected: PASS (same acceptable-flake caveat as Task 2, Step 6).

- [ ] **Step 5: Commit**

```bash
git add design-system/src/screens/Gallery/Gallery.tsx
git commit -m "docs(design-system): add TwoPaneModal to the component gallery"
```

---

### Task 4: Live-verify and close out the docs

**Files:**
- Modify: `docs/architecture/ui.md` (§11.6 bespoke list)
- Modify: `CLAUDE.md` (Project state block)
- Modify: `docs/superpowers/2026-07-17-ds-migration-progress.md` (the 2026-07-19 addendum)

**Interfaces:**
- Consumes: the merged work of Tasks 1–3.
- Produces: nothing.

- [ ] **Step 1: Live-verify under a full Tauri restart**

**Force a full recompile** — a hot-reloaded frontend on a stale Rust binary produces convincing phantom bugs (documented gotcha). Run `npm run tauri dev` from a clean start against `feature-test-vault`. Confirm:
1. Settings opens (⌘/Ctrl+, or the topbar gear) and renders two panes.
2. All **seven** nav tabs switch and show the right pane; the active tab is highlighted.
3. Escape closes it; scrim click closes it; clicking inside the panel does not.
4. The Shortcuts tab still renders its `<kbd>` chips styled (proves the `.kb-row kbd` rename).
5. Section headings still render styled (proves the `.set-h2` rename).
6. The **delete-confirm dialog** (right-click a file → Delete) still renders and closes — it uses the untouched single-column `Modal`.

Record the outcome honestly in the commit/handoff, including anything that could not be verified.

- [ ] **Step 2: Update the durable bespoke list**

In `docs/architecture/ui.md` §11.6, the sentence currently naming two remaining bespoke surfaces must drop the Settings modal, leaving the OmniBar as the sole remaining one. Replace:

> Only two surfaces remain bespoke, each awaiting a net-new primitive still parked in #35: the ranked multi-kind **OmniBar** palette (…) and the two-pane **Settings modal** (needs a nav+body `Modal` variant vs today's single-column one).

with:

> One surface remains bespoke, awaiting the last net-new primitive parked in #35: the ranked multi-kind **OmniBar** palette (needs a richer `CommandPalette` — the flat `{id,label,onRun}` DS one would regress its fuzzy rank, kind badges, and recency). The two-pane Settings modal was migrated to the DS `TwoPaneModal` primitive (2026-07-20).

Also add `TwoPaneModal` to the `#35` list in the 2026-07-19 addendum in `docs/superpowers/2026-07-17-ds-migration-progress.md`, and move the Settings modal from its "Still bespoke" sentence to the resolved list.

- [ ] **Step 3: Update the Project state block in `CLAUDE.md`**

Rewrite (never append) the `#35` sentence to read **6 of 7** primitives built+adopted+merged, naming `TwoPaneModal` and leaving only the richer ranked `CommandPalette` for OmniBar.

Also correct the **Tests** line in the same block: it currently reads `728 vitest`, which is stale — the measured baseline at plan time was 764, so after this work it is **771 vitest + 562 Rust**.

- [ ] **Step 4: Run the docs gate and commit**

```bash
python3 scripts/check_docs.py
git add docs/architecture/ui.md CLAUDE.md docs/superpowers/2026-07-17-ds-migration-progress.md
git commit -m "docs: record TwoPaneModal adoption (#35, 6 of 7)"
```

- [ ] **Step 5: Tick the issue-#35 checkbox**

Check the **Two-pane `Modal` variant** box in issue #35 with a merge note matching the style of the five already-done entries (`*(done, merged 2026-07-20; retired the bespoke .modal shell from layout.css.)*`):

```bash
gh issue view 35 --json body -q .body > /tmp/i35.md   # edit, then:
gh issue edit 35 --body-file /tmp/i35.md
```

---

## Notes for the implementer

- **Do not touch `Modal`, `CommandPalette`, or `Popover`.** The shared-`Overlay` refactor (spec approach C) is a deliberate future follow-up, not part of this plan.
- The `.set-info-btn` ⓘ / `.set-info-pop` rules and all `.set-row*` rules stay exactly where they are — they style body content the app still owns.
- If `scripts/check.sh` reports a vitest count other than 771, reconcile before committing; do not adjust the expected number to match a failure.
- **`CLAUDE.md`'s Project state records "728 vitest", which is stale** (the real baseline measured at plan time is 764). Correct it to 771 as part of Task 4, Step 3.
