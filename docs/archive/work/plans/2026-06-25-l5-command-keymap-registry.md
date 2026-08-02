> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L5 — Command / Keymap Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cubical's scattered keyboard handlers with one central command/keymap registry in the `core/` substrate, behaviour-preserving.

**Architecture:** A **pure core** (`ui/src/core/commands.ts`) owns the command/binding *types*, the static binding table, key-string matching, and command resolution — no DOM, no Solid, and it imports nothing from any feature. Thin adapters consume it: `App.tsx` builds a command map from its own closures and drives a single global `keydown`; `Editor.tsx` generates its CodeMirror keymap from the editor-scope bindings. This is the first piece of the L5 (Approach A) substrate; the Copy-as-Markdown action and any later shortcut work register against it.

**Tech Stack:** TypeScript, SolidJS, CodeMirror 6 (`@codemirror/view` `keymap`), Vitest.

## Global Constraints

- Substrate never imports a feature: `core/commands.ts` imports nothing from `sidebar/`, `editor/`, `omnibar/`, `settings/`, `statusbar/`, or `App.tsx`. Features/adapters inject their `run` closures. (CLAUDE.md non-negotiable #7; [composition refactor](2026-06-23-ui-composition-refactor.md).)
- All colors/fonts/spacings stay in `tokens.css` — N/A here (no styling), but no hardcoded UI strings beyond command titles.
- Bindings are a **static const table** in v1 — no user remapping, no reactive rebinding.
- Behaviour-preserving: the existing shortcuts (`Mod-k` omni-bar, `Mod-e` raw-source toggle, `Mod-Shift-b` copy-block-ref) must work identically after migration.
- Tests run from `ui/`: `npx vitest run <path>`. Full gate: `scripts/check.sh`.
- Key specs use CodeMirror notation: `Mod-` (⌘ on mac / Ctrl elsewhere), `Shift-`, `Alt-`, then the key (e.g. `Mod-Shift-b`).

---

### Task 1: Core types + static binding table + duplicate-key guard

**Files:**
- Create: `ui/src/core/commands.ts`
- Test: `ui/src/core/commands.test.ts`

**Interfaces:**
- Produces:
  - `type CommandScope = "global" | "editor"`
  - `interface Command { id: string; title: string; run: () => void; when?: () => boolean }`
  - `interface KeyBinding { key: string; command: string; scope: CommandScope }`
  - `const DEFAULT_BINDINGS: readonly KeyBinding[]`
  - `function findDuplicateBindings(bindings: readonly KeyBinding[]): string[]` — returns `"scope:key"` for any (scope, key) claimed more than once.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/core/commands.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_BINDINGS, findDuplicateBindings } from "./commands";

describe("findDuplicateBindings", () => {
  it("returns [] when every (scope,key) is unique", () => {
    expect(
      findDuplicateBindings([
        { key: "Mod-k", command: "omnibar.toggle", scope: "global" },
        { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" },
      ]),
    ).toEqual([]);
  });

  it("flags a (scope,key) claimed twice", () => {
    expect(
      findDuplicateBindings([
        { key: "Mod-k", command: "a", scope: "global" },
        { key: "Mod-k", command: "b", scope: "global" },
      ]),
    ).toEqual(["global:Mod-k"]);
  });

  it("treats the same key in different scopes as distinct", () => {
    expect(
      findDuplicateBindings([
        { key: "Mod-k", command: "a", scope: "global" },
        { key: "Mod-k", command: "b", scope: "editor" },
      ]),
    ).toEqual([]);
  });

  it("ships a default binding table with no duplicates", () => {
    expect(findDuplicateBindings(DEFAULT_BINDINGS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: FAIL — `Cannot find module './commands'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/core/commands.ts
/**
 * Core substrate — command + keymap registry.
 *
 * Pure: types, the static binding table, key-string matching, and command
 * resolution. No DOM, no Solid; imports nothing from any feature. Adapters
 * (App.tsx global keydown, Editor.tsx CodeMirror keymap) inject the `run`
 * closures and wire this to their runtime. Bindings are a static const table
 * in v1 — no user remapping.
 */

/** Where a binding is active. */
export type CommandScope = "global" | "editor";

/** An invokable app action. `run` closures are supplied by adapters. */
export interface Command {
  id: string;
  title: string;
  run: () => void;
  /** Optional guard; when present and false, the binding does not fire. */
  when?: () => boolean;
}

/** A key → command mapping within a scope. Key uses CodeMirror notation. */
export interface KeyBinding {
  key: string;
  command: string;
  scope: CommandScope;
}

/**
 * The v1 binding table. Editor-scope entries are handed to CodeMirror;
 * global-scope entries are matched by the App-level keydown adapter.
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  { key: "Mod-k", command: "omnibar.toggle", scope: "global" },
  { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" },
  { key: "Mod-Shift-b", command: "editor.copyBlockRef", scope: "editor" },
];

/** Returns `"scope:key"` for every (scope, key) claimed more than once. */
export function findDuplicateBindings(
  bindings: readonly KeyBinding[],
): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const b of bindings) {
    const id = `${b.scope}:${b.key}`;
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): command/keymap registry types + binding table"
```

---

### Task 2: Pure key matching (DOM event ↔ key spec)

**Files:**
- Modify: `ui/src/core/commands.ts`
- Modify: `ui/src/core/commands.test.ts`

**Interfaces:**
- Consumes: `KeyBinding` (Task 1).
- Produces:
  - `interface KeyChord { mod: boolean; shift: boolean; alt: boolean; key: string }`
  - `function parseKeySpec(spec: string): KeyChord` — parses CM notation; `key` is lower-cased.
  - `function eventToChord(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string }): KeyChord` — `mod` is `metaKey || ctrlKey`.
  - `function chordMatches(spec: string, e: …): boolean` — true when the parsed spec equals the event chord.

- [ ] **Step 1: Write the failing test**

```ts
// append to ui/src/core/commands.test.ts
import { parseKeySpec, chordMatches } from "./commands";

const ev = (o: Partial<{
  metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string;
}>) => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "", ...o,
});

describe("parseKeySpec", () => {
  it("parses modifiers and lower-cases the key", () => {
    expect(parseKeySpec("Mod-Shift-B")).toEqual({
      mod: true, shift: true, alt: false, key: "b",
    });
  });
  it("parses a bare key", () => {
    expect(parseKeySpec("k")).toEqual({
      mod: false, shift: false, alt: false, key: "k",
    });
  });
});

describe("chordMatches", () => {
  it("matches Mod-k against metaKey", () => {
    expect(chordMatches("Mod-k", ev({ metaKey: true, key: "k" }))).toBe(true);
  });
  it("matches Mod-k against ctrlKey", () => {
    expect(chordMatches("Mod-k", ev({ ctrlKey: true, key: "k" }))).toBe(true);
  });
  it("is case-insensitive on the event key", () => {
    expect(chordMatches("Mod-k", ev({ metaKey: true, key: "K" }))).toBe(true);
  });
  it("rejects when an extra modifier is held", () => {
    expect(
      chordMatches("Mod-k", ev({ metaKey: true, shiftKey: true, key: "k" })),
    ).toBe(false);
  });
  it("rejects a bare key when no modifier required and one is held", () => {
    expect(chordMatches("k", ev({ metaKey: true, key: "k" }))).toBe(false);
  });
  it("matches Mod-Shift-b", () => {
    expect(
      chordMatches("Mod-Shift-b", ev({ metaKey: true, shiftKey: true, key: "b" })),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: FAIL — `parseKeySpec`/`chordMatches` are not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ui/src/core/commands.ts

/** A normalized key chord. `key` is always lower-cased. */
export interface KeyChord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Parse a CodeMirror-notation spec ("Mod-Shift-b") into a {@link KeyChord}. */
export function parseKeySpec(spec: string): KeyChord {
  const parts = spec.split("-");
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  return {
    mod: mods.includes("mod"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt"),
    key,
  };
}

interface KeyEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/** Normalize a DOM keyboard event into a {@link KeyChord}. */
export function eventToChord(e: KeyEventLike): KeyChord {
  return {
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.toLowerCase(),
  };
}

/** True when `spec` exactly describes the chord of event `e`. */
export function chordMatches(spec: string, e: KeyEventLike): boolean {
  const a = parseKeySpec(spec);
  const b = eventToChord(e);
  return (
    a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): pure key-chord matching for the registry"
```

---

### Task 3: Global command resolver

**Files:**
- Modify: `ui/src/core/commands.ts`
- Modify: `ui/src/core/commands.test.ts`

**Interfaces:**
- Consumes: `Command`, `KeyBinding`, `chordMatches` (Tasks 1–2).
- Produces:
  - `function resolveGlobal(bindings, commands, e): Command | undefined` — finds the first `global`-scope binding matching event `e` whose command exists and whose `when?.()` is not `false`. Signature:
    `resolveGlobal(bindings: readonly KeyBinding[], commands: Record<string, Command>, e: KeyEventLike): Command | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ui/src/core/commands.test.ts
import { resolveGlobal, type Command } from "./commands";

const cmd = (id: string, when?: () => boolean): Command => ({
  id, title: id, run: () => {}, when,
});

describe("resolveGlobal", () => {
  const binds = [
    { key: "Mod-k", command: "omnibar.toggle", scope: "global" as const },
    { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" as const },
  ];

  it("returns the matching global command", () => {
    const cmds = { "omnibar.toggle": cmd("omnibar.toggle") };
    const r = resolveGlobal(binds, cmds, ev({ metaKey: true, key: "k" }));
    expect(r?.id).toBe("omnibar.toggle");
  });

  it("ignores editor-scope bindings", () => {
    const cmds = { "editor.toggleRawSource": cmd("editor.toggleRawSource") };
    expect(resolveGlobal(binds, cmds, ev({ metaKey: true, key: "e" }))).toBeUndefined();
  });

  it("skips a command whose when() is false", () => {
    const cmds = { "omnibar.toggle": cmd("omnibar.toggle", () => false) };
    expect(resolveGlobal(binds, cmds, ev({ metaKey: true, key: "k" }))).toBeUndefined();
  });

  it("returns undefined when no binding matches", () => {
    const cmds = { "omnibar.toggle": cmd("omnibar.toggle") };
    expect(resolveGlobal(binds, cmds, ev({ key: "x" }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: FAIL — `resolveGlobal` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ui/src/core/commands.ts

/**
 * Resolve a keyboard event to the global command it should run, or
 * `undefined`. Honors `when?.()` guards and ignores non-`global` bindings.
 */
export function resolveGlobal(
  bindings: readonly KeyBinding[],
  commands: Record<string, Command>,
  e: KeyEventLike,
): Command | undefined {
  for (const b of bindings) {
    if (b.scope !== "global") continue;
    if (!chordMatches(b.key, e)) continue;
    const c = commands[b.command];
    if (!c) continue;
    if (c.when && !c.when()) continue;
    return c;
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): global command resolver with when() guards"
```

---

### Task 4: CodeMirror keymap generator

**Files:**
- Modify: `ui/src/core/commands.ts`
- Modify: `ui/src/core/commands.test.ts`

**Interfaces:**
- Consumes: `Command`, `KeyBinding` (Tasks 1, 3).
- Produces:
  - `function toCmBindings(bindings, commands): { key: string; run: () => boolean }[]` — one entry per `editor`-scope binding whose command exists. The `run` invokes the command (respecting `when?.()`) and returns `true` when it ran, `false` otherwise (so CodeMirror falls through). Shape matches CodeMirror's `KeyBinding` (`@codemirror/view`).

- [ ] **Step 1: Write the failing test**

```ts
// append to ui/src/core/commands.test.ts
import { toCmBindings } from "./commands";

describe("toCmBindings", () => {
  const binds = [
    { key: "Mod-k", command: "omnibar.toggle", scope: "global" as const },
    { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" as const },
  ];

  it("emits one entry per editor-scope binding with an existing command", () => {
    let ran = 0;
    const cmds = { "editor.toggleRawSource": { ...cmd("editor.toggleRawSource"), run: () => { ran++; } } };
    const out = toCmBindings(binds, cmds);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("Mod-e");
    expect(out[0].run()).toBe(true);
    expect(ran).toBe(1);
  });

  it("run() returns false (falls through) when when() is false", () => {
    const cmds = { "editor.toggleRawSource": cmd("editor.toggleRawSource", () => false) };
    const out = toCmBindings(binds, cmds);
    expect(out[0].run()).toBe(false);
  });

  it("omits bindings whose command is missing", () => {
    expect(toCmBindings(binds, {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: FAIL — `toCmBindings` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ui/src/core/commands.ts

/**
 * Build CodeMirror keymap entries from the `editor`-scope bindings. Each
 * `run` invokes the command (honoring `when?.()`) and returns `true` when it
 * ran so CodeMirror stops, `false` to fall through to later handlers. The
 * returned shape is CodeMirror's `KeyBinding` ({ key, run }).
 */
export function toCmBindings(
  bindings: readonly KeyBinding[],
  commands: Record<string, Command>,
): { key: string; run: () => boolean }[] {
  const out: { key: string; run: () => boolean }[] = [];
  for (const b of bindings) {
    if (b.scope !== "editor") continue;
    const c = commands[b.command];
    if (!c) continue;
    out.push({
      key: b.key,
      run: () => {
        if (c.when && !c.when()) return false;
        c.run();
        return true;
      },
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `ui/`): `npx vitest run src/core/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts
git commit -m "feat(core): CodeMirror keymap generator from binding table"
```

---

### Task 5: Migrate App.tsx global keydown to the resolver

**Files:**
- Modify: `ui/src/App.tsx` (the `onGlobalKey` handler near line 1178–1188; imports near top)

**Interfaces:**
- Consumes: `DEFAULT_BINDINGS`, `resolveGlobal`, `type Command` (Tasks 1, 3).

**Note:** This is behaviour-preserving integration. The pure resolver is already tested (Task 3); App wiring stays thin. Verify by build + the full suite, then a manual smoke.

- [ ] **Step 1: Add the import**

In `ui/src/App.tsx`, alongside the other `core/` imports (near the `persistSetting`/`seedSetting` import, line ~44):

```ts
import {
  DEFAULT_BINDINGS,
  resolveGlobal,
  type Command,
} from "./core/commands";
```

- [ ] **Step 2: Build the global command map and replace the handler**

Replace the existing block (lines ~1178–1188):

```ts
    // L4-C: global Cmd/Ctrl+K toggles the Omni-Bar (no-op without a vault).
    const onGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (!vaultId()) return;
        e.preventDefault();
        void ensureTagsLoaded();
        setOmniOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", onGlobalKey));
```

with the registry-driven version:

```ts
    // Global shortcuts run through the core command registry. Commands are
    // built from App closures here (the substrate stays feature-agnostic).
    const globalCommands: Record<string, Command> = {
      "omnibar.toggle": {
        id: "omnibar.toggle",
        title: "Toggle Omni-Bar",
        when: () => vaultId() !== null,
        run: () => {
          void ensureTagsLoaded();
          setOmniOpen((v) => !v);
        },
      },
    };
    const onGlobalKey = (e: KeyboardEvent) => {
      const c = resolveGlobal(DEFAULT_BINDINGS, globalCommands, e);
      if (!c) return;
      e.preventDefault();
      c.run();
    };
    window.addEventListener("keydown", onGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", onGlobalKey));
```

- [ ] **Step 3: Type-check and run the suite**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all vitest pass.

- [ ] **Step 4: Manual smoke**

Run the app (`scripts/` dev command). With a vault open, press Cmd/Ctrl+K → Omni-Bar toggles. With no vault, Cmd/Ctrl+K does nothing. Confirm no double-toggle and no console errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "refactor(app): drive global Cmd/Ctrl+K through the command registry"
```

---

### Task 6: Migrate Editor.tsx keymap to the generator

**Files:**
- Modify: `ui/src/Editor.tsx` (the `keymap.of([...])` block, lines ~474–508)

**Interfaces:**
- Consumes: `DEFAULT_BINDINGS`, `toCmBindings`, `type Command` (Tasks 1, 4).

**Note:** Behaviour-preserving. The `Mod-e` and `Mod-Shift-b` entries move into the registry-generated bindings; the `ArrowUp`/`ArrowDown` embed-motion handlers stay inline (they are editor-internal cursor motion, not app commands), as do `defaultKeymap`/`historyKeymap`.

- [ ] **Step 1: Add the import**

In `ui/src/Editor.tsx`, near the existing `@codemirror` imports:

```ts
import { DEFAULT_BINDINGS, toCmBindings, type Command } from "./core/commands";
```

- [ ] **Step 2: Build editor commands and replace the two inline entries**

Just before `view = new EditorView({` (line ~468), build the command map from the props (which are stable for the view's lifetime):

```ts
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
          const head = view.state.selection.main.head;
          const text = view.state.doc.toString();
          props.onCopyBlockRef?.(byteOffsetOf(text, head));
        },
      },
    };
```

Then in the `keymap.of([...])` array, replace the two inline `{ key: "Mod-e", … }` and `{ key: "Mod-Shift-b", … }` objects with a spread of the generated bindings, keeping the Arrow handlers and defaults:

```ts
          keymap.of([
            ...toCmBindings(DEFAULT_BINDINGS, editorCommands),
            // Correct vertical cursor motion around tall block embeds. (…unchanged…)
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

> Note: `editor.copyBlockRef`'s `run` closes over the `view` binding declared on the next line. Because `view = new EditorView(...)` assigns the outer `let view`, and `run` is only invoked after construction, the reference is valid at call time. If the linter flags use-before-assign, declare the `editorCommands` map immediately *after* the `new EditorView` assignment and pass the keymap via a `Compartment` reconfigure, or read `view` lazily inside `run` (it already does). The lazy read inside `run` is the intended pattern — no change needed.

- [ ] **Step 3: Type-check and run the suite**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all vitest pass.

- [ ] **Step 4: Manual smoke**

In the editor: `Mod-e` toggles raw source; `Mod-Shift-b` copies a block ref at the cursor; Arrow up/down still steps correctly around an embed card. No console errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/Editor.tsx
git commit -m "refactor(editor): generate CM6 keymap from the command registry"
```

---

### Task 7: Gate + docs

**Files:**
- Modify: `docs/architecture/ui.md` (§11.2 Global triggers — note the central registry)

- [ ] **Step 1: Run the full gate**

Run (from repo root): `scripts/check.sh`
Expected: all green (fmt/clippy/test, tsc, vitest, build, docs).

- [ ] **Step 2: Document the registry**

In `ui.md` §11.2 (Global triggers), add one line recording that app-level and editor shortcuts are now defined in the `core/commands.ts` registry (single source of truth; CM6 keymap generated from it). Keep it terse — this is the owner doc for the trigger surface.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/ui.md
git commit -m "docs(l5): record central command/keymap registry"
```

---

## Self-Review

**Spec coverage** (against [§6 of the design](../specs/2026-06-25-layer-5-daily-driver-polish-design.md)):
- "Command = `{ id, title, run, when? }`, binding maps key→id within scope" → Task 1. ✓
- "Static const binding table, no remapping" → `DEFAULT_BINDINGS`, Task 1. ✓
- "Consolidates existing app-level handlers" → Tasks 5–6 (Mod-k, Mod-e, Mod-Shift-b). ✓
- "CM6 keymap generated from editor-scope bindings" → Task 4 + Task 6. ✓
- "Dev-time test asserts no duplicate key within a scope" → Task 1 (`findDuplicateBindings`, default-table test). ✓
- Substrate never imports a feature → `core/commands.ts` has zero feature imports; closures injected by adapters. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `Command`, `KeyBinding`, `CommandScope`, `KeyChord` defined in Task 1–2 and reused unchanged in Tasks 3–6. `resolveGlobal`/`toCmBindings`/`chordMatches` signatures match their call sites in App.tsx/Editor.tsx. ✓

**Note on scope:** This plan is one of four L5 surfaces (theme picker, export, perf pass each get their own plan). It produces working, testable software on its own — a behaviour-preserving consolidation that later surfaces build on.
