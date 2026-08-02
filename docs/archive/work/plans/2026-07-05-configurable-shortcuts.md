> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Configurable Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users rebind the app's keyboard shortcuts from Settings → Shortcuts, with changes taking effect immediately and persisting per-vault.

**Architecture:** A single metadata table (`COMMAND_DEFAULTS`) in `ui/src/core/commands.ts` is the source of truth for every rebindable command's id/title/scope/default key. A new per-vault setting (`shortcuts.overrides`, a `{commandId: keySpec}` diff) is merged with that table at runtime via a pure `resolveBindings` function, producing the `KeyBinding[]` both the App-level global keydown handler and the CodeMirror editor keymap already consume. A new `ShortcutsPanel` component replaces the read-only Settings tab with editable rows (click-to-capture, conflict detection, reset-to-default).

**Tech Stack:** SolidJS + TypeScript (`ui/`), CodeMirror 6 (`@codemirror/state` `Compartment`), Vitest.

## Global Constraints

- No backend/Rust changes — `shortcuts.overrides` is a per-vault setting stored via the existing generic `get_setting`/`set_setting` IPC, exactly like every other setting in this codebase.
- No unbind (empty-shortcut) capability — every command always has exactly one active shortcut (spec decision, confirmed with the user).
- Capturing a bare key with no modifier (`Mod`/`Shift`/`Alt`) is rejected with an inline error; a bare `Escape` (no modifiers) cancels capture instead of being recorded — this must hold for both "global" and "editor" scope commands, so a rebind can never shadow ordinary typing.
- Conflict checks only compare bindings within the same scope — `global` and `editor` are independent key spaces and never conflict with each other.
- Single chords only (no chord sequences like "press K then B") — matches the shape of every binding today.
- This repo has no component-rendering test setup (no `@solidjs/testing-library`, no existing `*.test.tsx` files) — interactive components (`Properties.tsx`, `PendingRewrites.tsx`, `SearchPanel.tsx`) are manual-smoke-tested only, not unit-tested. `ShortcutsPanel.tsx` and the `App.tsx`/`Editor.tsx` wiring follow that same precedent; only the pure logic in `commands.ts` gets automated tests.
- Design reference: `docs/superpowers/specs/2026-07-05-configurable-shortcuts-design.md`.

---

### Task 1: Command metadata table + pure resolve/conflict/display logic

**Files:**
- Modify: `ui/src/core/commands.ts`
- Test: `ui/src/core/commands.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–4): `export interface BindingDefault { id: string; title: string; scope: CommandScope; defaultKey: string }`, `export const COMMAND_DEFAULTS: readonly BindingDefault[]`, `export function resolveBindings(overrides: Record<string, string>): KeyBinding[]`, `export function findConflict(spec: string, scope: CommandScope, bindings: readonly KeyBinding[], excludeCommandId: string): string | undefined`, `export function specFromChord(chord: KeyChord): string`, `export function formatChordForDisplay(spec: string): string[]`.
- `DEFAULT_BINDINGS`'s exported name and `KeyBinding[]` shape are unchanged — only its implementation (now derived from `COMMAND_DEFAULTS`) changes, so `App.tsx`'s current import keeps compiling until Task 4 touches it.

- [ ] **Step 1: Write the failing tests for `COMMAND_DEFAULTS` / `resolveBindings`**

Add to `ui/src/core/commands.test.ts` (new `describe` blocks, alongside the existing ones):

```ts
import {
  COMMAND_DEFAULTS,
  resolveBindings,
  findConflict,
  specFromChord,
  formatChordForDisplay,
} from "./commands";

describe("resolveBindings", () => {
  it("returns the default binding table when there are no overrides", () => {
    expect(resolveBindings({})).toEqual(DEFAULT_BINDINGS);
  });

  it("overrides one command's key and leaves the rest at default", () => {
    const out = resolveBindings({ "omnibar.toggle": "Mod-Shift-p" });
    expect(out.find((b) => b.command === "omnibar.toggle")?.key).toBe(
      "Mod-Shift-p",
    );
    expect(
      out.find((b) => b.command === "editor.toggleRawSource")?.key,
    ).toBe("Mod-e");
  });

  it("ignores an override for a command id that doesn't exist", () => {
    expect(resolveBindings({ "no.such.command": "Mod-z" })).toEqual(
      DEFAULT_BINDINGS,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: FAIL — `resolveBindings`, `COMMAND_DEFAULTS` etc. are not exported yet.

- [ ] **Step 3: Replace the static `DEFAULT_BINDINGS` block with the metadata table + `resolveBindings`**

In `ui/src/core/commands.ts`, replace:

```ts
/**
 * The v1 binding table. Editor-scope entries are handed to CodeMirror;
 * global-scope entries are matched by the App-level keydown adapter.
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  { key: "Mod-k", command: "omnibar.toggle", scope: "global" },
  { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" },
  { key: "Mod-Shift-b", command: "editor.copyBlockRef", scope: "editor" },
];
```

with:

```ts
/**
 * Metadata for every rebindable command: its default key, human-readable
 * title (for the Settings → Shortcuts UI), and scope. `DEFAULT_BINDINGS`
 * and the Settings panel are both derived from this one table, so adding
 * a command later only means adding one entry here.
 */
export interface BindingDefault {
  id: string;
  title: string;
  scope: CommandScope;
  defaultKey: string;
}

export const COMMAND_DEFAULTS: readonly BindingDefault[] = [
  {
    id: "omnibar.toggle",
    title: "Open Omni-Bar",
    scope: "global",
    defaultKey: "Mod-k",
  },
  {
    id: "editor.toggleRawSource",
    title: "Toggle raw source / Live Preview",
    scope: "editor",
    defaultKey: "Mod-e",
  },
  {
    id: "editor.copyBlockRef",
    title: "Copy block reference",
    scope: "editor",
    defaultKey: "Mod-Shift-b",
  },
];

/**
 * The v1 binding table. Editor-scope entries are handed to CodeMirror;
 * global-scope entries are matched by the App-level keydown adapter.
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = COMMAND_DEFAULTS.map(
  (c) => ({ key: c.defaultKey, command: c.id, scope: c.scope }),
);

/**
 * Merge `overrides` (command id → key spec, from the `shortcuts.overrides`
 * setting) with {@link COMMAND_DEFAULTS} into the effective binding table.
 * A diff, not a snapshot: a command with no entry in `overrides` falls
 * through to its default, so a future default-table change is picked up
 * automatically. An override whose key no longer matches any
 * `COMMAND_DEFAULTS` entry is silently ignored — this only ever iterates
 * the default table, never the override object's own keys.
 */
export function resolveBindings(
  overrides: Record<string, string>,
): KeyBinding[] {
  return COMMAND_DEFAULTS.map((c) => ({
    key: overrides[c.id] ?? c.defaultKey,
    command: c.id,
    scope: c.scope,
  }));
}
```

- [ ] **Step 4: Run the tests to verify Step 1's tests pass**

Run: `npx vitest run src/core/commands.test.ts`
Expected: The three new tests pass; all pre-existing tests in this file (`findDuplicateBindings`, `parseKeySpec`, `chordMatches`, `resolveGlobal`, `toCmBindings`) still pass unchanged — `DEFAULT_BINDINGS` is byte-for-byte the same table, just built differently.

- [ ] **Step 5: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): add COMMAND_DEFAULTS table and resolveBindings"
```

- [ ] **Step 6: Write the failing tests for `findConflict`**

Add to `ui/src/core/commands.test.ts`:

```ts
describe("findConflict", () => {
  const bindings = [
    { key: "Mod-k", command: "omnibar.toggle", scope: "global" as const },
    {
      key: "Mod-e",
      command: "editor.toggleRawSource",
      scope: "editor" as const,
    },
  ];

  it("returns the colliding command id within the same scope", () => {
    expect(
      findConflict("Mod-e", "editor", bindings, "editor.copyBlockRef"),
    ).toBe("editor.toggleRawSource");
  });

  it("does not flag a match in a different scope", () => {
    expect(
      findConflict("Mod-k", "editor", bindings, "editor.toggleRawSource"),
    ).toBeUndefined();
  });

  it("excludes the command being edited from its own conflict check", () => {
    expect(
      findConflict("Mod-e", "editor", bindings, "editor.toggleRawSource"),
    ).toBeUndefined();
  });

  it("returns undefined for a key nothing is bound to", () => {
    expect(
      findConflict("Mod-Shift-z", "editor", bindings, "editor.copyBlockRef"),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run src/core/commands.test.ts`
Expected: FAIL — `findConflict` is not defined.

- [ ] **Step 8: Implement `findConflict`**

Add to `ui/src/core/commands.ts`, after the `chordMatches` function:

```ts
/**
 * Returns the command id already bound to `spec` within `scope` (ignoring
 * `excludeCommandId`, so re-capturing a row's own current key never
 * conflicts with itself), or `undefined` if `spec` is free. `global` and
 * `editor` are independent key spaces — a match in the other scope is not
 * a conflict.
 */
export function findConflict(
  spec: string,
  scope: CommandScope,
  bindings: readonly KeyBinding[],
  excludeCommandId: string,
): string | undefined {
  const chord = parseKeySpec(spec);
  for (const b of bindings) {
    if (b.scope !== scope) continue;
    if (b.command === excludeCommandId) continue;
    const other = parseKeySpec(b.key);
    if (
      other.mod === chord.mod &&
      other.shift === chord.shift &&
      other.alt === chord.alt &&
      other.key === chord.key
    ) {
      return b.command;
    }
  }
  return undefined;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/core/commands.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): add findConflict for shortcut rebinding"
```

- [ ] **Step 11: Write the failing tests for `specFromChord` / `formatChordForDisplay`**

Add to `ui/src/core/commands.test.ts`:

```ts
describe("specFromChord", () => {
  it("builds a Mod-only spec", () => {
    expect(specFromChord({ mod: true, shift: false, alt: false, key: "k" })).toBe(
      "Mod-k",
    );
  });
  it("builds a Mod-Shift spec", () => {
    expect(
      specFromChord({ mod: true, shift: true, alt: false, key: "b" }),
    ).toBe("Mod-Shift-b");
  });
  it("builds an Alt-only spec", () => {
    expect(specFromChord({ mod: false, shift: false, alt: true, key: "j" })).toBe(
      "Alt-j",
    );
  });
});

describe("formatChordForDisplay", () => {
  it("renders a Mod-only chord", () => {
    expect(formatChordForDisplay("Mod-k")).toEqual(["⌘/Ctrl", "K"]);
  });
  it("renders a Mod-Shift chord and uppercases the key", () => {
    expect(formatChordForDisplay("Mod-Shift-b")).toEqual([
      "⌘/Ctrl",
      "⇧",
      "B",
    ]);
  });
});
```

- [ ] **Step 12: Run the tests to verify they fail**

Run: `npx vitest run src/core/commands.test.ts`
Expected: FAIL — neither function is defined.

- [ ] **Step 13: Implement `specFromChord` and `formatChordForDisplay`**

Add to `ui/src/core/commands.ts`, after `findConflict`:

```ts
/** Build a key spec string (CodeMirror notation) from a captured chord. */
export function specFromChord(chord: KeyChord): string {
  const mods: string[] = [];
  if (chord.mod) mods.push("Mod");
  if (chord.shift) mods.push("Shift");
  if (chord.alt) mods.push("Alt");
  return [...mods, chord.key].join("-");
}

/**
 * Render a key spec as the ordered `<kbd>` labels the Settings UI
 * displays (e.g. `"Mod-Shift-b"` → `["⌘/Ctrl", "⇧", "B"]`). `parseKeySpec`
 * always lower-cases the key; this uppercases single-character keys for
 * display since that's how the previous hand-written Settings JSX showed
 * them.
 */
export function formatChordForDisplay(spec: string): string[] {
  const chord = parseKeySpec(spec);
  const labels: string[] = [];
  if (chord.mod) labels.push("⌘/Ctrl");
  if (chord.shift) labels.push("⇧");
  if (chord.alt) labels.push("⌥/Alt");
  labels.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return labels;
}
```

- [ ] **Step 14: Run the full test file to verify everything passes**

Run: `npx vitest run src/core/commands.test.ts`
Expected: PASS, all tests in the file (old and new).

- [ ] **Step 15: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): add specFromChord and formatChordForDisplay"
```

---

### Task 2: Reconfigurable editor keymap

**Files:**
- Modify: `ui/src/Editor.tsx`

**Interfaces:**
- Consumes (from Task 1): `resolveBindings` is not used here — `Editor.tsx` receives an already-resolved `KeyBinding[]` from its parent (built in Task 4) and just needs `toCmBindings`/`DEFAULT_BINDINGS`/`type KeyBinding`, all already exported from `commands.ts`.
- Produces (consumed by Task 4): `EditorProps` gains `editorBindings?: KeyBinding[]`.

- [ ] **Step 1: Add the `editorBindings` prop**

In `ui/src/Editor.tsx`, in the `EditorProps` interface, insert after the `autocompleteProvider` prop (right before `onNavigateWikilink`):

```ts
  /**
   * Effective key bindings — `DEFAULT_BINDINGS` merged with the user's
   * Settings → Shortcuts overrides. Only `editor`-scope entries apply
   * here (`toCmBindings` ignores the rest). `undefined` (parent hasn't
   * loaded overrides yet) falls back to `DEFAULT_BINDINGS`.
   */
  editorBindings?: KeyBinding[];
```

Update the import line to bring in the type:

```ts
import { DEFAULT_BINDINGS, toCmBindings, type Command, type KeyBinding } from "./core/commands";
```

- [ ] **Step 2: Add the keymap compartment**

In `ui/src/Editor.tsx`, after the `autocompleteCompartment` declaration (the last of the compartment consts, just before the `Editor` component starts), add:

```ts
/**
 * Holds the CM6 keymap built from the effective key bindings.
 * Reconfigured whenever the parent's `editorBindings` prop changes (a
 * shortcut was remapped in Settings), so a rebind takes effect on the
 * already-open editor without reopening the file.
 */
const keymapCompartment = new Compartment();
```

- [ ] **Step 3: Hoist `editorCommands` out of `onMount`**

In `ui/src/Editor.tsx`, this block currently sits inside `onMount`, right before `view = new EditorView(...)`:

```ts
    // Editor shortcuts run through the core command registry. `run` closes
    // over the outer `view` (assigned just below); commands fire only on
    // keystroke, by which point `view` is set.
    const editorCommands: Record<string, Command> = {
      "editor.toggleRawSource": {
        id: "editor.toggleRawSource",
        title: "Toggle raw source",
        run: () => props.onToggleRawSource?.(),
      },
      "editor.copyBlockRef": {
        id: "editor.copyBlockRef",
        title: "Copy block reference",
        run: () => {
          if (!view) return;
          const head = view.state.selection.main.head;
          const text = view.state.doc.toString();
          props.onCopyBlockRef?.(byteOffsetOf(text, head));
        },
      },
    };
```

Delete it from inside `onMount`, and add the identical block at the top level of the `Editor` component instead — immediately before the `onMount(() => {` call (i.e. right after the `handleTagClickAtPos` function definition). Nothing in the block changes: it only references the outer `let view` and `props`, both already reachable from that scope, so moving it doesn't change behavior — it's now just reusable by a later `createEffect` as well as by `onMount`.

Immediately after the hoisted `editorCommands` block (same top-level spot, still before `onMount`), add a helper that builds the keymap extension from a binding list — this is the one place the keymap's contents are assembled, so the initial construction and the later reconfigure effect both call it instead of duplicating the array:

```ts
  // Builds the CM6 keymap extension from the effective bindings. Called
  // both at initial construction and whenever `editorBindings` changes,
  // so the keymap's contents are defined in exactly one place.
  const buildEditorKeymap = (bindings: KeyBinding[] | undefined) =>
    keymap.of([
      ...toCmBindings(bindings ?? DEFAULT_BINDINGS, editorCommands),
      // Correct vertical cursor motion around tall block embeds. CM6's
      // geometric Up/Down overshoots a multi-row embed card (one document
      // line, many screen rows); these handlers detect the overshoot and
      // step exactly one document line so the cursor can land on the
      // embed line. No-op for normal lines (returns false → default
      // motion runs). Must precede defaultKeymap so it wins for Arrow
      // keys.
      {
        key: "ArrowUp",
        run: (view) => verticalDocLineMotion(view, false),
      },
      {
        key: "ArrowDown",
        run: (view) => verticalDocLineMotion(view, true),
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]);
```

- [ ] **Step 4: Route the initial keymap through the compartment**

In `ui/src/Editor.tsx`, inside the `extensions: [...]` array built in `onMount`, replace:

```ts
          keymap.of([
            ...toCmBindings(DEFAULT_BINDINGS, editorCommands),
            // Correct vertical cursor motion around tall block embeds.
            // CM6's geometric Up/Down overshoots a multi-row embed card
            // (one document line, many screen rows); these handlers
            // detect the overshoot and step exactly one document line so
            // the cursor can land on the embed line. No-op for normal
            // lines (returns false → default motion runs). Must precede
            // defaultKeymap so it wins for Arrow keys.
            {
              key: "ArrowUp",
              run: (view) => verticalDocLineMotion(view, false),
            },
            {
              key: "ArrowDown",
              run: (view) => verticalDocLineMotion(view, true),
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
```

with:

```ts
          keymapCompartment.of(buildEditorKeymap(props.editorBindings)),
```

- [ ] **Step 5: Reconfigure the compartment when `editorBindings` changes**

In `ui/src/Editor.tsx`, after the existing autocomplete `createEffect` (the one reconfiguring `autocompleteCompartment`, immediately before the `onCleanup(() => { ... })` block), add:

```ts
  // Rebuild the CM6 keymap when the effective bindings change (the user
  // remapped a shortcut in Settings).
  createEffect(
    on(
      () => props.editorBindings,
      (bindings) => {
        view?.dispatch({
          effects: keymapCompartment.reconfigure(buildEditorKeymap(bindings)),
        });
      },
      { defer: true },
    ),
  );
```

- [ ] **Step 6: Typecheck and run the existing suite**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: Both succeed with no new errors or failures — `editorBindings` is optional and every existing caller (there's only one, `App.tsx`, not yet updated) keeps compiling and behaving exactly as before via the `?? DEFAULT_BINDINGS` fallback.

- [ ] **Step 7: Commit**

```bash
git add ui/src/Editor.tsx
git commit -m "feat(editor): make the CM6 keymap reconfigurable via a new prop"
```

---

### Task 3: `ShortcutsPanel` settings component

**Files:**
- Create: `ui/src/settings/ShortcutsPanel.tsx`

**Interfaces:**
- Consumes (from Task 1): `COMMAND_DEFAULTS`, `resolveBindings`, `findConflict`, `specFromChord`, `formatChordForDisplay`, `eventToChord`, `type CommandScope`, all from `../core/commands`.
- Produces (consumed by Task 4): `export interface ShortcutsPanelProps { overrides: Record<string, string>; onChange: (next: Record<string, string>) => void }` and `export default ShortcutsPanel: Component<ShortcutsPanelProps>`.

- [ ] **Step 1: Create the component**

Create `ui/src/settings/ShortcutsPanel.tsx`:

```tsx
import { Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  COMMAND_DEFAULTS,
  eventToChord,
  findConflict,
  formatChordForDisplay,
  resolveBindings,
  specFromChord,
  type CommandScope,
} from "../core/commands";

export interface ShortcutsPanelProps {
  /** Command id → key spec, only for commands the user has changed. */
  overrides: Record<string, string>;
  /** Called with the full next `overrides` object on every change. */
  onChange: (next: Record<string, string>) => void;
}

/**
 * Settings → Shortcuts. One editable row per `COMMAND_DEFAULTS` entry:
 * click "Change" to capture a new chord (Esc cancels, a same-scope
 * conflict shows inline and keeps capture open), "Reset" removes the
 * override so the command falls back to its default.
 */
const ShortcutsPanel: Component<ShortcutsPanelProps> = (props) => {
  const [listeningId, setListeningId] = createSignal<string | null>(null);
  const [errorFor, setErrorFor] = createSignal<{ id: string; message: string } | null>(
    null,
  );

  const effectiveBindings = () => resolveBindings(props.overrides);
  const keyFor = (id: string) =>
    effectiveBindings().find((b) => b.command === id)?.key ?? "";

  const startListening = (id: string) => {
    setListeningId(id);
    setErrorFor(null);
  };

  // Capture the next keydown at the window while a row is listening.
  // Runs in the capture phase so it wins over any other handler
  // (including CodeMirror's own keymap, if an editor happens to be
  // focused underneath the Settings modal).
  createEffect(() => {
    const id = listeningId();
    if (id === null) return;
    const target = COMMAND_DEFAULTS.find((c) => c.id === id);
    if (!target) return;
    const scope: CommandScope = target.scope;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bare = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
      if (bare && e.key === "Escape") {
        setListeningId(null);
        return;
      }
      if (bare) {
        setErrorFor({ id, message: "Shortcuts need a modifier key" });
        return;
      }
      const spec = specFromChord(eventToChord(e));
      const conflictWith = findConflict(spec, scope, effectiveBindings(), id);
      if (conflictWith) {
        const title =
          COMMAND_DEFAULTS.find((c) => c.id === conflictWith)?.title ??
          conflictWith;
        setErrorFor({ id, message: `Already used by ${title}` });
        return;
      }
      props.onChange({ ...props.overrides, [id]: spec });
      setListeningId(null);
      setErrorFor(null);
    };

    window.addEventListener("keydown", handler, { capture: true });
    onCleanup(() =>
      window.removeEventListener("keydown", handler, { capture: true }),
    );
  });

  const resetRow = (id: string) => {
    const next = { ...props.overrides };
    delete next[id];
    props.onChange(next);
  };

  return (
    <>
      <h2 class="modal__h2">Shortcuts</h2>
      <For each={COMMAND_DEFAULTS}>
        {(c) => (
          <div class="kb-row">
            <span>{c.title}</span>
            <Show
              when={listeningId() === c.id}
              fallback={
                <For each={formatChordForDisplay(keyFor(c.id))}>
                  {(label) => <kbd>{label}</kbd>}
                </For>
              }
            >
              <kbd>Press keys…</kbd>
            </Show>
            <button type="button" class="chrome-btn" onClick={() => startListening(c.id)}>
              Change
            </button>
            <Show when={props.overrides[c.id] !== undefined}>
              <button type="button" class="chrome-btn" onClick={() => resetRow(c.id)}>
                Reset
              </button>
            </Show>
            <Show when={errorFor()?.id === c.id}>
              <p
                role="alert"
                style={{
                  margin: 0,
                  "font-size": "var(--text-xs)",
                  color: "var(--c-warning)",
                }}
              >
                {errorFor()?.message}
              </p>
            </Show>
          </div>
        )}
      </For>
    </>
  );
};

export default ShortcutsPanel;
```

- [ ] **Step 2: Typecheck**

Run (from `ui/`): `npx tsc --noEmit`
Expected: No errors. (No automated test for this file — matches this repo's existing convention of leaving interactive components like `Properties.tsx`/`PendingRewrites.tsx` to manual smoke testing; end-to-end verification happens in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/settings/ShortcutsPanel.tsx
git commit -m "feat(ui): add ShortcutsPanel for editable keyboard shortcuts"
```

---

### Task 4: Wire persistence, effective bindings, and the Settings tab

**Files:**
- Modify: `ui/src/api/ipc.ts`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes (from Tasks 1–3): `resolveBindings` (from `./core/commands`), `ShortcutsPanel`/`ShortcutsPanelProps` (from `./settings/ShortcutsPanel`), `Editor`'s new `editorBindings` prop (from Task 2).

- [ ] **Step 1: Add the `shortcuts.overrides` setting type**

In `ui/src/api/ipc.ts`, in the `Setting` union, add a new member (order doesn't matter; append at the end before the closing `;`):

```ts
  | { key: "shortcuts.overrides"; value: Record<string, string> };
```

(This turns the previous last member's trailing `;` into a leading `|` continuation — i.e. change the existing last line

```ts
  | { key: "wikilinks.rewrite_broken_links_on_rename"; value: boolean };
```

to:

```ts
  | { key: "wikilinks.rewrite_broken_links_on_rename"; value: boolean }
  | { key: "shortcuts.overrides"; value: Record<string, string> };
```

)

- [ ] **Step 2: Typecheck the isolated type change**

Run (from `ui/`): `npx tsc --noEmit`
Expected: No errors (this is an additive union member; nothing consumes it yet).

- [ ] **Step 3: Add the `shortcutOverrides` signal and derived `effectiveBindings`**

In `ui/src/App.tsx`, update the import from `./core/commands` (currently `DEFAULT_BINDINGS, resolveGlobal, type Command`) to also bring in `resolveBindings`:

```ts
import {
  resolveBindings,
  resolveGlobal,
  type Command,
} from "./core/commands";
```

(`DEFAULT_BINDINGS` is dropped from this import — after Step 6 below it has no remaining use in `App.tsx`.)

Add the import for the new panel, alongside the `Properties` import:

```ts
import ShortcutsPanel from "./settings/ShortcutsPanel";
```

Add the new signal right before the `type SettingsTab = ...` declaration:

```ts
  // `shortcuts.overrides` — command id → key spec, only for commands the
  // user has rebound from default. Seeded on vault open, absent → `{}`
  // (every command at its factory default). `effectiveBindings` is what
  // both the global keydown handler and the editor's CM6 keymap actually
  // resolve against.
  const [shortcutOverrides, setShortcutOverrides] = createSignal<
    Record<string, string>
  >({});
  const setShortcutOverridesValue = (next: Record<string, string>) => {
    setShortcutOverrides(next);
    persistSetting(vaultId(), "shortcuts.overrides", next);
  };
  const effectiveBindings = createMemo(() =>
    resolveBindings(shortcutOverrides()),
  );
```

- [ ] **Step 4: Reset the signal on vault open, and seed it from settings**

In `ui/src/App.tsx`, in the vault-open reset block, add one line right after `setRightSidebarPanel("backlinks");`:

```ts
      setShortcutOverrides({});
```

Then, in the same function's `seedSetting` sequence, add a new call right after the existing:

```ts
      await seedSetting(
        resp.vault_id,
        "ui.right_sidebar_panel",
        "backlinks",
        setRightSidebarPanel,
      );
```

insert:

```ts
      await seedSetting(
        resp.vault_id,
        "shortcuts.overrides",
        {},
        setShortcutOverrides,
      );
```

- [ ] **Step 5: Use `effectiveBindings` for global shortcut resolution**

In `ui/src/App.tsx`, in `onGlobalKey`, replace:

```ts
      const c = resolveGlobal(DEFAULT_BINDINGS, globalCommands, e);
```

with:

```ts
      const c = resolveGlobal(effectiveBindings(), globalCommands, e);
```

- [ ] **Step 6: Pass the effective bindings to `Editor`**

In `ui/src/App.tsx`, in the `<Editor ... />` element, add a new prop (anywhere among the existing data props, e.g. right after `autocompleteProvider`):

```tsx
                  editorBindings={effectiveBindings()}
```

- [ ] **Step 7: Replace the static Shortcuts tab with `ShortcutsPanel`**

In `ui/src/App.tsx`, replace the entire block:

```tsx
              <Show when={settingsTab() === "shortcuts"}>
                <h2 class="modal__h2">Shortcuts</h2>
                <div class="kb-row">
                  <span>Open Omni-Bar</span>
                  <kbd>⌘/Ctrl</kbd>
                  <kbd>K</kbd>
                </div>
                <div class="kb-row">
                  <span>Toggle raw source / Live Preview</span>
                  <kbd>⌘/Ctrl</kbd>
                  <kbd>E</kbd>
                </div>
                <div class="kb-row">
                  <span>Copy block reference</span>
                  <kbd>⌘/Ctrl</kbd>
                  <kbd>⇧</kbd>
                  <kbd>B</kbd>
                </div>
              </Show>
```

with:

```tsx
              <Show when={settingsTab() === "shortcuts"}>
                <ShortcutsPanel
                  overrides={shortcutOverrides()}
                  onChange={setShortcutOverridesValue}
                />
              </Show>
```

- [ ] **Step 8: Typecheck and run the full test suite**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: Both succeed with no failures.

- [ ] **Step 9: Manual smoke test**

Run the app (`npm run tauri dev` from repo root, or the project's usual dev-run command) with a vault open, then:
1. Open Settings → Shortcuts. Confirm the three commands show with their current (default) chords.
2. Click "Change" on "Open Omni-Bar", press `Cmd/Ctrl+Shift+P`. Confirm the row updates to show the new chord and a "Reset" button appears.
3. Press `Cmd/Ctrl+Shift+P` anywhere in the app (outside Settings) — confirm the Omni-Bar opens. Press the old default `Cmd/Ctrl+K` — confirm it no longer opens the Omni-Bar.
4. Click "Change" on "Copy block reference", press `Cmd/Ctrl+E` (currently "Toggle raw source"'s key). Confirm an inline "Already used by Toggle raw source / Live Preview" error appears and the row stays in listening state.
5. While still listening, press `Escape`. Confirm capture cancels and the row reverts to showing its current chord (not an error).
6. While still listening, press a bare `j` (no modifier). Confirm the inline "Shortcuts need a modifier key" error appears and capture stays open.
7. With a file open in the editor, change "Copy block reference" to `Cmd/Ctrl+Shift+J` and confirm it fires (copies a block ref) without reopening the file.
8. Click "Reset" on "Open Omni-Bar". Confirm it reverts to `Cmd/Ctrl+K` and the Reset button disappears.
9. Close and reopen the vault (or restart the app). Confirm the "Copy block reference" rebind from step 7 persisted.

- [ ] **Step 10: Commit**

```bash
git add ui/src/api/ipc.ts ui/src/App.tsx
git commit -m "feat(ui): wire configurable shortcuts into Settings and the app"
```
