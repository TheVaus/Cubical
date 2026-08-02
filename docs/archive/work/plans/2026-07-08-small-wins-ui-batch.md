> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Small-wins UI batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five isolated frontend UI wins in one batch — muted file-type labels, three new bindable commands, editor back/forward navigation, a minimal vault-switcher popup, and clearer Settings copy.

**Architecture:** All changes are frontend (Solid/TS) in `ui/src`. Pure, testable logic goes in dependency-free modules (`fileTree.ts` extension split, a new `navHistory.ts` reducer); Solid components (`App.tsx`, `Editor.tsx`, a new `VaultSwitcher.tsx`) are the thin adapters and are operator-smoke-only per conventions. No Rust, no IPC, no `.md`/`.cubical` changes.

**Tech Stack:** SolidJS, TypeScript, CodeMirror 6, Vitest. Design spec: [`2026-07-08-small-wins-ui-batch-design.md`](../specs/2026-07-08-small-wins-ui-batch-design.md).

## Global Constraints

- **No new IPC, no Rust changes, no persistence.** #3 explicitly ships without the deferred global recent-vaults store.
- **Pure logic is unit-tested; Solid/CM components are operator-smoke-only** (conventions §tests). `fileTree.ts` and `navHistory.ts` stay dependency-free.
- **Keybinding defaults match Obsidian**, stored once in CodeMirror `Mod-` notation (`Mod` = ⌘ macOS / Ctrl Windows): `nav.back`=`Mod-Alt-ArrowLeft`, `nav.forward`=`Mod-Alt-ArrowRight`, `file.new`=`Mod-n`, `view.toggleSidebar`=`Mod-Shift-l`, `editor.followWikilink`=`Alt-Enter`.
- **One commit per task.** Build order is fixed: Task 1 (#5) → Task 2 (#7 commands) → Task 3 (#4 nav) → Task 4 (#3 switcher) → Task 5 (#8 copy).
- **Green gate:** `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) must pass before each commit; run at minimum `cd ui && npx vitest run <file>` for the touched tests during a task.

---

### Task 1: Muted file-type labels (#5)

**Files:**
- Modify: `ui/src/sidebar/fileTree.ts` (add pure `splitFileName`)
- Test: `ui/src/sidebar/fileTree.test.ts`
- Modify: `ui/src/App.tsx:1886-1892` (file-row label render) + `ui/src/App.tsx:1898` (row classList)
- Modify: `ui/src/styles/layout.css` (new `.tree-row__ext` rule)

**Interfaces:**
- Produces: `export function splitFileName(name: string): { stem: string; ext: string }` — `ext` is the extension **without** the dot (`""` when none); a leading-dot dotfile (`.gitignore`) has `ext === ""` and `stem === name`.

**Design note (behavior change — confirm at review):** Today markdown rows hide `.md` (App.tsx:1889-1892) and non-markdown rows mute the *whole* row (`tree-row--muted`, App.tsx:1898). Per the approved spec this becomes uniform: every file shows `stem` in normal color + a trailing muted `.{ext}` label. This un-hides `.md` (now a faint suffix on notes) and drops the whole-row mute in favor of muting only the extension. Keep the invalid-note-name dotted-underline treatment (App.tsx:1930-1938) unchanged.

- [ ] **Step 1: Write the failing test** — append to `ui/src/sidebar/fileTree.test.ts`:

```ts
import { splitFileName } from "./fileTree";

describe("splitFileName", () => {
  it("splits a normal extension", () => {
    expect(splitFileName("roadmap.md")).toEqual({ stem: "roadmap", ext: "md" });
  });
  it("returns empty ext when there is no dot", () => {
    expect(splitFileName("README")).toEqual({ stem: "README", ext: "" });
  });
  it("treats a leading-dot dotfile as all stem", () => {
    expect(splitFileName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });
  it("splits on the last dot for multi-dot names", () => {
    expect(splitFileName("a.b.md")).toEqual({ stem: "a.b", ext: "md" });
  });
  it("preserves case", () => {
    expect(splitFileName("A.MD")).toEqual({ stem: "A", ext: "MD" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/sidebar/fileTree.test.ts`
Expected: FAIL — `splitFileName is not a function` / not exported.

- [ ] **Step 3: Implement `splitFileName`** — add to `ui/src/sidebar/fileTree.ts` (below the `FileLeaf` interface, near the top-level exports):

```ts
/**
 * Split a basename into its display stem and extension (extension
 * *without* the leading dot). A name with no dot, or a leading-dot
 * dotfile like `.gitignore`, yields `ext === ""` and the whole name as
 * the stem. Splits on the last dot for multi-dot names (`a.b.md`).
 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/sidebar/fileTree.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the file-row render in `App.tsx`** — replace the `display()` memo at `App.tsx:1889-1892`:

```tsx
                        const parts = () => splitFileName(row.name);
```

Then replace the label body at `App.tsx:1940` (the `{display()}` expression inside `<span class="tree-row__name">`) with:

```tsx
                                  {parts().stem}
                                  <Show when={parts().ext !== ""}>
                                    <span class="tree-row__ext">
                                      .{parts().ext}
                                    </span>
                                  </Show>
```

Add the import at the top of `App.tsx` (extend the existing `./sidebar/fileTree` import that already brings in `buildFileTree`, `countFilesUnderFolder`, `type FlatRow`):

```tsx
  splitFileName,
```

Remove `"tree-row--muted": !isMarkdown,` from the file-row `classList` at `App.tsx:1898` (whole-row mute is replaced by the muted extension span). Leave the `--dotted` invalid-name logic intact.

- [ ] **Step 6: Add the muted-extension style** — append to `ui/src/styles/layout.css` (reuse an existing muted-text token; grep the file for the token used by `tree-row--muted` and reuse it):

```css
.tree-row__ext {
  color: var(--text-muted);
  opacity: 0.7;
}
```

(If `--text-muted` is not the token name in this file, use whatever muted-foreground token `.tree-row--muted` currently references — do not introduce a new color primitive.)

- [ ] **Step 7: Operator smoke** — `cd ui && npm run tauri dev`; open a vault containing both `.md` notes and at least one non-markdown file (e.g. a `.txt` or `.png`). Confirm: notes show `name` + faint `.md`; other files show `name` + faint `.<ext>`; a no-extension file shows just the name; invalid note names still show the dotted underline.

- [ ] **Step 8: Run full frontend gate**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/src/sidebar/fileTree.ts ui/src/sidebar/fileTree.test.ts ui/src/App.tsx ui/src/styles/layout.css
git commit -m "feat(sidebar): muted file-type extension labels in the file tree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Three new bindable commands (#7)

**Files:**
- Modify: `ui/src/core/commands.ts:43-62` (add three `COMMAND_DEFAULTS` rows)
- Test: `ui/src/core/commands.test.ts`
- Modify: `ui/src/App.tsx:1348-1358` (`globalCommands` — add `view.toggleSidebar`, `file.new`)
- Modify: `ui/src/Editor.tsx:541-557` (`editorCommands` — add `editor.followWikilink`)

**Interfaces:**
- Consumes: `toggleLeftSidebar` (App.tsx:371), `handleNewFile` (App.tsx:1118), `handleClickAtPos(view, pos)` (Editor.tsx:466).
- Produces: command ids `view.toggleSidebar`, `file.new`, `editor.followWikilink` in `COMMAND_DEFAULTS` — the Shortcuts panel (`<For each={COMMAND_DEFAULTS}>`, ShortcutsPanel.tsx:92) renders them automatically.

**Note:** `nav.back` / `nav.forward` are intentionally NOT added here — Task 3 owns them so their `run` closures land with the nav-history state they need.

- [ ] **Step 1: Write the failing test** — append to `ui/src/core/commands.test.ts`:

```ts
import { COMMAND_DEFAULTS, resolveBindings, findDuplicateBindings } from "./commands";

describe("new bindable commands (#7)", () => {
  const ids = COMMAND_DEFAULTS.map((c) => c.id);
  it("registers the three new commands with Obsidian-matched defaults", () => {
    expect(COMMAND_DEFAULTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "editor.followWikilink", scope: "editor", defaultKey: "Alt-Enter" }),
        expect.objectContaining({ id: "view.toggleSidebar", scope: "global", defaultKey: "Mod-Shift-l" }),
        expect.objectContaining({ id: "file.new", scope: "global", defaultKey: "Mod-n" }),
      ]),
    );
  });
  it("introduces no default-binding conflicts", () => {
    expect(findDuplicateBindings(resolveBindings({}))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/core/commands.test.ts`
Expected: FAIL — the three ids are not in `COMMAND_DEFAULTS`.

- [ ] **Step 3: Add the `COMMAND_DEFAULTS` rows** — insert into the array in `ui/src/core/commands.ts` (after the existing `editor.copyBlockRef` entry, before the closing `]`):

```ts
  {
    id: "editor.followWikilink",
    title: "Follow link under cursor",
    scope: "editor",
    defaultKey: "Alt-Enter",
  },
  {
    id: "view.toggleSidebar",
    title: "Toggle left sidebar",
    scope: "global",
    defaultKey: "Mod-Shift-l",
  },
  {
    id: "file.new",
    title: "New note",
    scope: "global",
    defaultKey: "Mod-n",
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/core/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the two global commands** — in `ui/src/App.tsx`, extend the `globalCommands` record (App.tsx:1348) by adding, after the `omnibar.toggle` entry:

```ts
      "view.toggleSidebar": {
        id: "view.toggleSidebar",
        title: "Toggle left sidebar",
        when: () => vaultId() !== null,
        run: () => toggleLeftSidebar(),
      },
      "file.new": {
        id: "file.new",
        title: "New note",
        when: () => vaultId() !== null,
        run: () => void handleNewFile(),
      },
```

- [ ] **Step 6: Wire the editor command** — in `ui/src/Editor.tsx`, extend the `editorCommands` record (Editor.tsx:541) by adding, after the `editor.copyBlockRef` entry:

```ts
    "editor.followWikilink": {
      id: "editor.followWikilink",
      title: "Follow link under cursor",
      run: () => {
        if (!view) return;
        // Reuse the click router: same WikiLink-node lookup + resolve +
        // navigate/offer-create path, but seeded from the cursor head
        // instead of a click position. handleClickAtPos returns false
        // when the cursor isn't inside a wiki-link; toCmBindings ignores
        // that and consumes Alt-Enter regardless, which is fine since
        // Alt-Enter has no other binding.
        handleClickAtPos(view, view.state.selection.main.head);
      },
    },
```

(`handleClickAtPos` is defined at Editor.tsx:466, above `editorCommands`, and closes over the same `view`.)

- [ ] **Step 7: Verify types + full frontend gate**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Operator smoke** — `npm run tauri dev`: with the cursor inside a `[[wikilink]]`, press Alt+Enter → the target opens (or a create-offer appears for a missing target). Press ⌘/Ctrl+Shift+L → left sidebar toggles. Press ⌘/Ctrl+N → a new Untitled note opens. Open Settings → Shortcuts and confirm all three rows appear and are rebindable with conflict-checking.

- [ ] **Step 9: Commit**

```bash
git add ui/src/core/commands.ts ui/src/core/commands.test.ts ui/src/App.tsx ui/src/Editor.tsx
git commit -m "feat(shortcuts): add follow-wikilink, toggle-sidebar, new-note commands

Obsidian-matched defaults (Alt-Enter, Mod-Shift-l, Mod-n).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Editor back/forward navigation (#4)

**Files:**
- Create: `ui/src/navHistory.ts` (pure reducer)
- Test: `ui/src/navHistory.test.ts`
- Modify: `ui/src/App.tsx` — new `navState` signal + `canBack`/`canForward` memos; push in `handleSelectFile` (App.tsx:942); `goBack`/`goForward` handlers; two ‹ › topbar buttons (App.tsx:1611-1622); two `nav.back`/`nav.forward` global commands (App.tsx:1348) + `COMMAND_DEFAULTS` rows (commands.ts).
- Modify: `ui/src/core/commands.ts` (two more `COMMAND_DEFAULTS` rows)

**Interfaces:**
- Produces (from `navHistory.ts`):
  - `export interface NavState { stack: string[]; index: number }`
  - `export const emptyNav: NavState` (= `{ stack: [], index: -1 }`)
  - `export function navPush(s: NavState, path: string): NavState`
  - `export function navBack(s: NavState): NavState`
  - `export function navForward(s: NavState): NavState`
  - `export function navCurrent(s: NavState): string | null`
  - `export function canBack(s: NavState): boolean`
  - `export function canForward(s: NavState): boolean`
- Consumes: `handleSelectFile(file, knownHash?, opts?)` (App.tsx:942) gains a third arg; `files()` for FileEntry lookup.

- [ ] **Step 1: Write the failing test** — create `ui/src/navHistory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyNav,
  navPush,
  navBack,
  navForward,
  navCurrent,
  canBack,
  canForward,
} from "./navHistory";

describe("navHistory", () => {
  it("starts empty with nothing current and no moves", () => {
    expect(navCurrent(emptyNav)).toBeNull();
    expect(canBack(emptyNav)).toBe(false);
    expect(canForward(emptyNav)).toBe(false);
  });

  it("pushes in order and tracks current", () => {
    let s = navPush(emptyNav, "a.md");
    s = navPush(s, "b.md");
    s = navPush(s, "c.md");
    expect(navCurrent(s)).toBe("c.md");
    expect(canBack(s)).toBe(true);
    expect(canForward(s)).toBe(false);
  });

  it("collapses a consecutive duplicate push", () => {
    let s = navPush(emptyNav, "a.md");
    s = navPush(s, "a.md");
    expect(s.stack).toEqual(["a.md"]);
    expect(s.index).toBe(0);
  });

  it("goes back and forward across the stack", () => {
    let s = navPush(navPush(navPush(emptyNav, "a.md"), "b.md"), "c.md");
    s = navBack(s);
    expect(navCurrent(s)).toBe("b.md");
    s = navBack(s);
    expect(navCurrent(s)).toBe("a.md");
    expect(canBack(s)).toBe(false);
    s = navForward(s);
    expect(navCurrent(s)).toBe("b.md");
  });

  it("truncates forward entries when pushing after going back", () => {
    let s = navPush(navPush(navPush(emptyNav, "a.md"), "b.md"), "c.md");
    s = navBack(s); // at b.md
    s = navPush(s, "d.md"); // branch: c.md dropped
    expect(s.stack).toEqual(["a.md", "b.md", "d.md"]);
    expect(navCurrent(s)).toBe("d.md");
    expect(canForward(s)).toBe(false);
  });

  it("back/forward at a boundary return an equivalent state", () => {
    const s = navPush(emptyNav, "a.md");
    expect(navBack(s).index).toBe(s.index);
    expect(navForward(s).index).toBe(s.index);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/navHistory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `navHistory.ts`** — create `ui/src/navHistory.ts`:

```ts
/**
 * Pure back/forward navigation history for the editor (session-scoped,
 * not persisted). A list-with-a-cursor: `stack` is the visited paths in
 * order, `index` points at the current one. Dependency-free so it
 * unit-tests without the app harness (conventions §tests).
 */

export interface NavState {
  stack: string[];
  index: number;
}

export const emptyNav: NavState = { stack: [], index: -1 };

export function navCurrent(s: NavState): string | null {
  return s.index >= 0 && s.index < s.stack.length ? s.stack[s.index] : null;
}

export function canBack(s: NavState): boolean {
  return s.index > 0;
}

export function canForward(s: NavState): boolean {
  return s.index < s.stack.length - 1;
}

/**
 * Record a visit to `path`. A push identical to the current entry is a
 * no-op (avoids dupe entries when re-opening the same file). Any forward
 * entries are dropped — the standard browser-history "new branch"
 * behaviour after going back.
 */
export function navPush(s: NavState, path: string): NavState {
  if (navCurrent(s) === path) return s;
  const stack = s.stack.slice(0, s.index + 1);
  stack.push(path);
  return { stack, index: stack.length - 1 };
}

export function navBack(s: NavState): NavState {
  return canBack(s) ? { stack: s.stack, index: s.index - 1 } : s;
}

export function navForward(s: NavState): NavState {
  return canForward(s) ? { stack: s.stack, index: s.index + 1 } : s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/navHistory.test.ts`
Expected: PASS.

- [ ] **Step 5: Add nav state + commands to `commands.ts`** — insert two more rows into `COMMAND_DEFAULTS` in `ui/src/core/commands.ts` (after the `file.new` entry from Task 2):

```ts
  {
    id: "nav.back",
    title: "Navigate back",
    scope: "global",
    defaultKey: "Mod-Alt-ArrowLeft",
  },
  {
    id: "nav.forward",
    title: "Navigate forward",
    scope: "global",
    defaultKey: "Mod-Alt-ArrowRight",
  },
```

- [ ] **Step 6: Extend the conflict test** — in `ui/src/core/commands.test.ts`, add to the "new bindable commands" describe block:

```ts
  it("registers nav back/forward with Obsidian-matched defaults and no conflict", () => {
    expect(COMMAND_DEFAULTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "nav.back", scope: "global", defaultKey: "Mod-Alt-ArrowLeft" }),
        expect.objectContaining({ id: "nav.forward", scope: "global", defaultKey: "Mod-Alt-ArrowRight" }),
      ]),
    );
    expect(findDuplicateBindings(resolveBindings({}))).toEqual([]);
  });
```

Run: `cd ui && npx vitest run src/core/commands.test.ts` → PASS.

- [ ] **Step 7: Add nav state, push hook, and handlers in `App.tsx`**

Add the import near the other local-module imports at the top of `App.tsx`:

```tsx
import {
  emptyNav,
  navPush,
  navBack,
  navForward,
  navCurrent,
  canBack,
  canForward,
  type NavState,
} from "./navHistory";
```

Add signal + memos near the other UI signals (e.g. just after `leftCollapsed`/`toggleLeftSidebar`, App.tsx:371):

```tsx
  // Session-scoped editor navigation history (#4). Reactive wrapper over
  // the pure navHistory reducer so the topbar ‹ › buttons re-evaluate.
  const [navState, setNavState] = createSignal<NavState>(emptyNav);
  const navCanBack = createMemo(() => canBack(navState()));
  const navCanForward = createMemo(() => canForward(navState()));
```

Change the `handleSelectFile` signature (App.tsx:942) to accept a history opt-out:

```tsx
  const handleSelectFile = async (
    file: FileEntry,
    knownHash?: string,
    opts?: { fromHistory?: boolean },
  ) => {
```

Add the push right after `setSelectedPath(file.path);` (App.tsx:962):

```tsx
    if (!opts?.fromHistory) setNavState((s) => navPush(s, file.path));
```

Add the back/forward handlers (near `handleSelectFile`):

```tsx
  const navigateToHistoryPath = (path: string) => {
    const existing = files().find((f) => f.path === path);
    const file: FileEntry = existing ?? {
      path,
      type_id: "markdown",
      size_bytes: 0,
      mtime_unix: 0,
    };
    void handleSelectFile(file, undefined, { fromHistory: true });
  };
  const goBack = () => {
    const next = navBack(navState());
    if (next.index === navState().index) return;
    setNavState(next);
    const path = navCurrent(next);
    if (path) navigateToHistoryPath(path);
  };
  const goForward = () => {
    const next = navForward(navState());
    if (next.index === navState().index) return;
    setNavState(next);
    const path = navCurrent(next);
    if (path) navigateToHistoryPath(path);
  };
```

- [ ] **Step 8: Wire the nav global commands** — add to the `globalCommands` record (App.tsx:1348), after the Task 2 entries:

```ts
      "nav.back": {
        id: "nav.back",
        title: "Navigate back",
        when: () => navCanBack(),
        run: () => goBack(),
      },
      "nav.forward": {
        id: "nav.forward",
        title: "Navigate forward",
        when: () => navCanForward(),
        run: () => goForward(),
      },
```

- [ ] **Step 9: Add the ‹ › topbar buttons** — in the left flank of the topbar (`App.tsx:1611`, inside `topbar__flank--left`, after the existing toggle-file-panel button at line 1621):

```tsx
          <button
            type="button"
            class="chrome-btn"
            onClick={goBack}
            disabled={!navCanBack()}
            aria-label="Navigate back"
            title="Navigate back (Cmd/Ctrl+Alt+←)"
          >
            ‹
          </button>
          <button
            type="button"
            class="chrome-btn"
            onClick={goForward}
            disabled={!navCanForward()}
            aria-label="Navigate forward"
            title="Navigate forward (Cmd/Ctrl+Alt+→)"
          >
            ›
          </button>
```

- [ ] **Step 10: Verify types + full frontend gate**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 11: Operator smoke** — `npm run tauri dev`: open note A, follow a `[[link]]` to B, follow another to C. The ‹ button is enabled; click it → back to B, again → A (‹ now disabled). › returns forward to B, C. From B, opening a different note D disables › (forward branch dropped). Confirm ⌘/Ctrl+Alt+← / → do the same, and that both rows appear in Settings → Shortcuts.

- [ ] **Step 12: Commit**

```bash
git add ui/src/navHistory.ts ui/src/navHistory.test.ts ui/src/core/commands.ts ui/src/core/commands.test.ts ui/src/App.tsx
git commit -m "feat(editor): back/forward navigation with topbar buttons + shortcuts

Session-scoped history via pure navHistory reducer; nav.back/nav.forward
commands default to Obsidian's Mod-Alt-Arrow keys.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Minimal vault-switcher popup (#3)

**Files:**
- Create: `ui/src/VaultSwitcher.tsx`
- Modify: `ui/src/App.tsx:1990-2002` (the `side__footer` vault button becomes the popup trigger) + a new `vaultSwitcherOpen` signal
- Modify: `ui/src/styles/layout.css` (popover styles, reuse existing popover tokens)

**Interfaces:**
- Produces: `VaultSwitcher` component with props
  `{ currentPath: string | null; recentVaults?: { path: string }[]; onOpenFolder: () => void; onDismiss: () => void }`.
  `recentVaults` defaults to `[]` — the forward-compatible seam for the deferred global recent-vaults store.
- Consumes: `handleOpen` (App.tsx:1390) for `onOpenFolder`; `vaultPath()` for `currentPath`.

**Note:** the trigger is the existing "Switch vault" button in `.side__footer` (App.tsx:1991-2002), **not** the topbar — it currently calls `handleOpen` directly; this task makes it toggle the popup instead.

- [ ] **Step 1: Create the component** — `ui/src/VaultSwitcher.tsx`:

```tsx
import { For, Show, onCleanup, onMount } from "solid-js";

/**
 * Minimal in-app vault switcher popover (#3). Shows the current vault
 * and an "Open folder…" action that wraps the existing open-vault flow.
 * `recentVaults` is a forward-compatible seam: today it is always empty
 * (no global recent-vaults store yet — deferred to its own session);
 * a future store populates the prop without changing this component.
 */
export interface VaultSwitcherProps {
  currentPath: string | null;
  recentVaults?: { path: string }[];
  onOpenFolder: () => void;
  onDismiss: () => void;
}

function vaultName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function VaultSwitcher(props: VaultSwitcherProps) {
  let root: HTMLDivElement | undefined;

  const onDocMouseDown = (e: MouseEvent) => {
    if (root && !root.contains(e.target as Node)) props.onDismiss();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onDismiss();
  };
  onMount(() => {
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onKey);
  });

  const recents = () => props.recentVaults ?? [];

  return (
    <div class="vault-switcher" role="dialog" aria-label="Switch vault" ref={root}>
      <div class="vault-switcher__current">
        <span class="vault-switcher__label">Current vault</span>
        <span class="vault-switcher__path" title={props.currentPath ?? ""}>
          {props.currentPath ? vaultName(props.currentPath) : "—"}
        </span>
      </div>
      <Show when={recents().length > 0}>
        <ul class="vault-switcher__recents">
          <For each={recents()}>
            {(v) => <li title={v.path}>{vaultName(v.path)}</li>}
          </For>
        </ul>
      </Show>
      <button
        type="button"
        class="vault-switcher__open"
        onClick={() => {
          props.onDismiss();
          props.onOpenFolder();
        }}
      >
        Open folder…
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Add the import at the top of `App.tsx`:

```tsx
import { VaultSwitcher } from "./VaultSwitcher";
```

Add a signal near the other modal/popover signals (e.g. after `settingsOpen`, App.tsx:373):

```tsx
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = createSignal(false);
```

Change the `side__footer` vault button (App.tsx:1991-2002) so `onClick` toggles the popup instead of calling `handleOpen`, and render the popover:

```tsx
                <div class="vault-switcher-anchor">
                  <button
                    type="button"
                    class="vault-btn"
                    onClick={() => setVaultSwitcherOpen((v) => !v)}
                    disabled={busy()}
                    aria-haspopup="dialog"
                    aria-expanded={vaultSwitcherOpen()}
                    title="Switch vault"
                  >
                    <span class="vault-btn__name">
                      {vaultPath()?.split("/").filter(Boolean).pop() ?? "vault"}
                    </span>
                    <span class="vault-btn__caret">⌄</span>
                  </button>
                  <Show when={vaultSwitcherOpen()}>
                    <VaultSwitcher
                      currentPath={vaultPath()}
                      onOpenFolder={() => void handleOpen()}
                      onDismiss={() => setVaultSwitcherOpen(false)}
                    />
                  </Show>
                </div>
```

- [ ] **Step 3: Add popover styles** — append to `ui/src/styles/layout.css` (reuse popover surface tokens already used by `.set-info-pop`; adjust token names to match that rule):

```css
.vault-switcher-anchor {
  position: relative;
}
.vault-switcher {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  left: 0;
  min-width: 12rem;
  padding: var(--space-2);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.vault-switcher__label {
  display: block;
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.vault-switcher__path {
  font-weight: 600;
}
.vault-switcher__open {
  width: 100%;
}
```

(Match `--surface-raised` / `--border` / `--shadow-pop` / `--radius` to the tokens the existing `.set-info-pop` rule uses — grep `layout.css` for it; do not invent new primitives.)

- [ ] **Step 4: Verify types + full frontend gate**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Operator smoke** — `npm run tauri dev`: click the vault name in the sidebar footer → popover opens showing the current vault name and an "Open folder…" button. Click "Open folder…" → the OS folder dialog opens and picking a folder switches vaults (popover closes). Re-open the popover and press Escape → it dismisses; open it and click outside → it dismisses.

- [ ] **Step 6: Commit**

```bash
git add ui/src/VaultSwitcher.tsx ui/src/App.tsx ui/src/styles/layout.css
git commit -m "feat(vault): in-app vault-switcher popup (minimal, no persistence)

Wraps the existing open-vault flow in an in-app popover; recentVaults
prop is a seam for the deferred global recent-vaults store.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Clearer Settings copy (#8)

**Files:**
- Modify: `ui/src/settings/settingsInfo.ts` (extend `InfoId` union)
- Test: `ui/src/settings/settingsInfo.test.ts`
- Modify: `ui/src/App.tsx` (Settings → Shortcuts tab help blurb, using the existing `InfoPop` mechanism)

**Interfaces:**
- Consumes: `toggleInfo`, `InfoId` (settingsInfo.ts), `openInfo`/`flipInfo` (App.tsx:400-401), the `InfoPop` local component (App.tsx ~1590), and `settingsTab() === "shortcuts"` (App.tsx:396).

**Scope (enumerated per spec):** #8 goes last and documents the surfaces added this batch. Add one new info popover — `"shortcuts"` — to the Shortcuts settings tab, with copy that explains rebinding and calls out the new commands (follow-link, toggle-sidebar, new-note, back/forward). This is the smallest honest slice of "clearer settings + instructions" that covers what this batch introduced; broader copy passes over the other tabs are out of scope for this task.

- [ ] **Step 1: Write the failing test** — update `ui/src/settings/settingsInfo.test.ts` to assert the new id round-trips through the reducer (mirror the existing per-id assertions; if the file has none yet, add):

```ts
import { describe, it, expect } from "vitest";
import { toggleInfo, type InfoId } from "./settingsInfo";

describe("settingsInfo shortcuts id", () => {
  it("toggles the shortcuts info id open and closed", () => {
    const id: InfoId = "shortcuts";
    expect(toggleInfo(null, id)).toBe("shortcuts");
    expect(toggleInfo("shortcuts", id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/settings/settingsInfo.test.ts`
Expected: FAIL — `"shortcuts"` is not assignable to `InfoId`.

- [ ] **Step 3: Extend the `InfoId` union** — in `ui/src/settings/settingsInfo.ts:2`:

```ts
export type InfoId =
  | "typed-props"
  | "wiki-repair"
  | "dataview"
  | "property-refs"
  | "shortcuts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/settings/settingsInfo.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the help popover to the Shortcuts tab** — in `App.tsx`, inside the Shortcuts settings tab render (where `settingsTab() === "shortcuts"` mounts `ShortcutsPanel`), add an `InfoPop` next to the tab heading using the same pattern as the other tabs:

```tsx
                <InfoPop id="shortcuts">
                  Click <strong>Change</strong> on any row, then press the key
                  combination you want. Escape cancels; a combo already used in
                  the same scope is rejected. New in this release: follow the
                  link under the cursor (Alt+Enter), toggle the left sidebar
                  (⌘/Ctrl+Shift+L), new note (⌘/Ctrl+N), and navigate
                  back/forward (⌘/Ctrl+Alt+←/→).
                </InfoPop>
```

(Place it adjacent to the Shortcuts tab title, matching how `InfoPop` is attached in the other tabs.)

- [ ] **Step 6: Verify types + full frontend gate**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Operator smoke** — `npm run tauri dev`: open Settings → Shortcuts, click the ⓘ → the help popover appears with the rebinding instructions and the new-command list; click ⓘ again → it closes.

- [ ] **Step 8: Commit**

```bash
git add ui/src/settings/settingsInfo.ts ui/src/settings/settingsInfo.test.ts ui/src/App.tsx
git commit -m "feat(settings): shortcuts help popover documenting new commands

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full gate: `bash scripts/check.sh` — fmt/clippy/test, tsc, vitest, build, docs all green.
- [ ] Confirm the five commits are present and scoped one-per-feature: `git log --oneline main..HEAD`.
- [ ] Update the CLAUDE.md Project state block and the `project_requested_ui_backlog` memory (mark #3/#4/#5/#7 done, #8's shortcuts-help slice done) at session close.
