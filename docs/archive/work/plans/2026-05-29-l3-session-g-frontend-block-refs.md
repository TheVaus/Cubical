> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session G frontend follow-up — block-ref gesture + `^id` decoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Copy block reference" editor gesture (mint a `^block-id` for the cursor's line via the existing `create_block_ref` IPC and copy a `[[path#^id]]` link to the clipboard) and a fence-aware `^id` live-preview decoration (muted off the cursor line, raw on it).

**Architecture:** Frontend-only — no backend changes. Two pure, unit-tested helpers (`byteOffsetOf`, `buildBlockRefLink`) and a pure decoration scanner (`findBlockIds`) carry the logic; thin glue wires a CM6 keymap entry through a new `Editor` prop to an `App` handler that orchestrates `flushAutosave → createBlockRef IPC → clipboard`. The backend's disk write rides the existing `vault:file-changed` silent-reload path to bring `^id` into the buffer. The `^id` decoration follows the `findFrontmatter` precedent: a direct doc scan (the markdown grammar has no `^id` node), merged into the live-preview plugin's decoration set.

**Tech Stack:** SolidJS, TypeScript, CodeMirror 6 (`@codemirror/view`, `@codemirror/state`), `@lezer/markdown` / `@lezer/common`, Vitest. Reuses the Session G IPC bindings already in `ui/src/api/ipc.ts` (`createBlockRef`).

**Branch:** Work on a new branch `l3-session-g-frontend` cut from `main` (single-checkout workflow — no worktrees).

**Design:** `docs/superpowers/specs/2026-05-29-l3-session-g-frontend-block-refs-design.md`.

---

## Background — read before touching code

You have no prior context. Read this and the referenced files before starting.

- **The backend already shipped** (`main`, layer-3-spec §9.8). `create_block_ref(vault_id, target_path, position)` reads the target file *on disk*, finds the line containing the byte `position`, appends ` ^<id>` (a deterministic id) unless the line already ends with a valid id, writes the file, persists a `blocks` row, and returns `{ block_id }`. It is the **sole minter** of block ids — do not mint ids on the frontend. The IPC binding `createBlockRef(req): Promise<CreateBlockRefResponse>` is already in `ui/src/api/ipc.ts` with `CreateBlockRefRequest { vault_id, target_path, position }` and `CreateBlockRefResponse { block_id }`.
- **A block id** is `^` + `[A-Za-z_][A-Za-z0-9_-]*` at the **end of a line**, preceded by whitespace or starting the line, **ignored inside fenced code**. This grammar is shared with the Rust scanner/minter and must stay identical.
- **Save model (`ui/src/App.tsx`).** `flushAutosave()` (line ~284) persists the buffer through `writeFileText`, recording `lastWrittenHash` / `seenHash`; it is serial and no-ops on a clean buffer. A module-level `dirty` flag tracks unsaved edits.
- **External-edit reload (`App.tsx` `onVaultFileChanged`, ~line 617–654).** For a change to the open file: own-write echoes (`incoming === lastWrittenHash`) are dropped; a **clean** buffer **silently reloads** via `editorApi.replaceContent`; a **dirty** buffer raises a conflict banner. `create_block_ref` writes the file with a fresh hash (not via `write_file_text`), so after `flushAutosave()` leaves the buffer clean, the gesture's disk write reloads silently — no banner.
- **Decorations (`ui/src/editor/decorations.ts`).** `collectDecorations(tree, doc, activeLine, resolverLookup?)` is the pure Lezer-driven core returning `DecoEntry[] { from, to, kind }`. `buildFor(view)` calls it and feeds `buildDecorationSet` (which calls `Decoration.set(ranges, true)` — the `true` sorts, so merge order is irrelevant). `findFrontmatter(doc)` is the precedent for a **non-Lezer** scan. `DecoKind` is a string union; markers reveal raw on the cursor line. Block IDs are explicitly "L3+, left raw" (line 30).
- **Code-context gating (`ui/src/editor/autocomplete.ts` `isInhibited`).** Walks the Lezer ancestor chain via `resolveInner(pos, …).parent` rejecting `FencedCode`/`CodeText`/`InlineCode`/etc. `findBlockIds` reuses this idea with the `Tree` it already holds.
- **Editor keymap + props (`ui/src/Editor.tsx`).** `keymap.of([...])` (line ~317) already binds `Mod-e` with `run: () => { props.onToggleRawSource?.(); return true; }`. CM6 keymap `run` receives the `EditorView`. `EditorProps` (line ~135) is the Editor→App seam; `<Editor>` is rendered in `App.tsx` (~line 1166).
- **Wiki-link resolution** accepts an exact vault-relative path with/without `.md`, so a `[[path-without-.md#^id]]` link is an unambiguous exact match even when basenames collide.

---

## File Structure

**Create:**
- `ui/src/editor/blockRef.ts` — two pure helpers: `byteOffsetOf(text, charPos)` and `buildBlockRefLink(path, blockId)`.
- `ui/src/editor/blockRef.test.ts` — unit tests for both.

**Modify:**
- `ui/src/editor/decorations.ts` — add `findBlockIds`, the `"mark-blockid"` `DecoKind`, its `Decoration.mark` + `buildDecorationSet` case + base-theme rule, and merge `findBlockIds` into `buildFor`.
- `ui/src/editor/decorations.test.ts` — tests for `findBlockIds`.
- `ui/src/Editor.tsx` — add the `onCopyBlockRef` prop and a `Mod-Shift-b` keymap entry.
- `ui/src/App.tsx` — import `createBlockRef`, add `handleCopyBlockRef`, pass `onCopyBlockRef` to `<Editor>`.
- `docs/layer-3-spec.md` — add §9.9 (frontend follow-up).
- `CLAUDE.md` — rewrite the Project state block.

---

### Task 1: Pure helpers — byte-offset + link builder

**Files:**
- Create: `ui/src/editor/blockRef.ts`
- Create: `ui/src/editor/blockRef.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/editor/blockRef.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildBlockRefLink, byteOffsetOf } from "./blockRef";

describe("byteOffsetOf", () => {
  it("equals the char position for pure ASCII", () => {
    expect(byteOffsetOf("hello world", 5)).toBe(5);
  });

  it("counts multi-byte chars before the cursor as their UTF-8 length", () => {
    // "café" → c,a,f = 3 bytes + é = 2 bytes = 5 bytes for 4 chars.
    expect(byteOffsetOf("café world", 4)).toBe(5);
  });

  it("counts an astral char (surrogate pair) as 4 bytes", () => {
    // "😀" is 2 UTF-16 code units and 4 UTF-8 bytes; cursor after it.
    expect(byteOffsetOf("😀x", 2)).toBe(4);
  });

  it("is 0 at the start", () => {
    expect(byteOffsetOf("anything", 0)).toBe(0);
  });
});

describe("buildBlockRefLink", () => {
  it("strips a trailing .md and wraps the block anchor", () => {
    expect(buildBlockRefLink("notes/Daily.md", "b1a2c3")).toBe(
      "[[notes/Daily#^b1a2c3]]",
    );
  });

  it("leaves a path without .md untouched", () => {
    expect(buildBlockRefLink("Foo", "x")).toBe("[[Foo#^x]]");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/editor/blockRef.test.ts`
Expected: FAIL — `./blockRef` does not exist (module not found).

- [ ] **Step 3: Implement the helpers**

Create `ui/src/editor/blockRef.ts`:

```ts
/**
 * Pure helpers for the "Copy block reference" gesture (L3 Session G
 * frontend). The gesture mints a `^block-id` via the backend and copies
 * a `[[path#^id]]` wiki-link; these two functions are the testable
 * pieces of that flow.
 */

/**
 * UTF-8 byte offset of `charPos` (a CodeMirror UTF-16 code-unit
 * position) into `text`. `create_block_ref` locates the target line by
 * byte offset, so the gesture must convert CM's char positions before
 * sending them.
 */
export function byteOffsetOf(text: string, charPos: number): number {
  return new TextEncoder().encode(text.slice(0, charPos)).length;
}

/**
 * Build the wiki-link to copy: `[[<path-without-.md>#^<blockId>]]`.
 * Stripping `.md` yields an exact vault-relative path match, which
 * resolves unambiguously even when two notes share a basename.
 */
export function buildBlockRefLink(path: string, blockId: string): string {
  const base = path.endsWith(".md") ? path.slice(0, -3) : path;
  return `[[${base}#^${blockId}]]`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/editor/blockRef.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/blockRef.ts ui/src/editor/blockRef.test.ts
git commit -m "feat(ui): pure helpers for block-ref gesture (byte offset + link)"
```

---

### Task 2: `^id` live-preview decoration

**Files:**
- Modify: `ui/src/editor/decorations.ts`
- Modify: `ui/src/editor/decorations.test.ts`

- [ ] **Step 1: Write the failing tests**

In `ui/src/editor/decorations.test.ts`, add an import for `findBlockIds` to the existing import from `./decorations`:

```ts
import {
  collectDecorations,
  findBlockIds,
  findFrontmatter,
  livePreviewDecorations,
  type DecoEntry,
  type DecoKind,
} from "./decorations";
```

Then add this block at the end of the file (the `parser` and `Text` helpers at the top are already in scope):

```ts
function runBlockIds(src: string, activeLine: number): DecoEntry[] {
  const tree = parser.parse(src);
  const doc = Text.of(src.split("\n"));
  return findBlockIds(doc, tree, activeLine);
}

describe("findBlockIds", () => {
  it("marks a trailing ^id off the cursor line", () => {
    // activeLine 3 (the blank/last line), so line 1's id is decorated.
    const got = runBlockIds("a paragraph ^intro\n\nother\n", 3);
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe("mark-blockid");
    // Range covers exactly "^intro".
    const src = "a paragraph ^intro";
    expect(got[0]?.from).toBe(src.indexOf("^"));
    expect(got[0]?.to).toBe(src.length);
  });

  it("marks an id alone on its own line", () => {
    const got = runBlockIds("para\n^solo\n", 1);
    expect(got).toHaveLength(1);
    // Line 2 starts after "para\n" = offset 5.
    expect(got[0]?.from).toBe(5);
    expect(got[0]?.to).toBe(5 + "^solo".length);
  });

  it("reveals (does not mark) the id on the active line", () => {
    const got = runBlockIds("a paragraph ^intro\n", 1);
    expect(got).toHaveLength(0);
  });

  it("ignores ^id inside a fenced code block", () => {
    const got = runBlockIds("```\nlet x = 1 ^nope\n```\nreal ^yes\n", 99);
    expect(got).toHaveLength(1);
    // The only match is on the "real ^yes" line.
    expect(got[0]?.to).toBe("```\nlet x = 1 ^nope\n```\nreal ^yes".length);
  });

  it("does not match mid-line or non-ws-preceded carets", () => {
    expect(runBlockIds("text ^mid more\n", 99)).toHaveLength(0);
    expect(runBlockIds("word^attached\n", 99)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/editor/decorations.test.ts`
Expected: FAIL — `findBlockIds` is not exported (compile error) / not defined.

- [ ] **Step 3: Add the `mark-blockid` kind + the scanner**

In `ui/src/editor/decorations.ts`:

(a) Extend the `SyntaxNode` import. Change the `@lezer/common` import line:

```ts
import { type SyntaxNode, type Tree } from "@lezer/common";
```

(b) Add `"mark-blockid"` to the `DecoKind` union (next to `"mark-tag"`):

```ts
  | "mark-tag"
  | "mark-blockid"
  | "mark-marker-muted"
```

(c) Add the scanner. Place it just after `findFrontmatter` (it is a sibling non-Lezer scan):

```ts
/** Trailing block id on a line: `^id` preceded by start-or-whitespace. */
const TRAILING_BLOCK_ID = /(^|\s)\^([A-Za-z_][A-Za-z0-9_-]*)\s*$/;

/** True when `pos` resolves inside a fenced/inline code construct. */
function isInsideCode(tree: Tree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node) {
    const n = node.name;
    if (
      n === "FencedCode" ||
      n === "CodeBlock" ||
      n === "CodeText" ||
      n === "InlineCode"
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/**
 * Scan every line for a trailing `^block-id` token (spec §2.7 grammar),
 * skipping the cursor line (revealed raw, like every marker) and any id
 * inside fenced/inline code. Returns `mark-blockid` entries. Pure; the
 * markdown grammar has no `^id` node, so this is a direct doc scan in
 * the `findFrontmatter` tradition rather than a Lezer walk.
 */
export function findBlockIds(
  doc: Text,
  tree: Tree,
  activeLine: number,
): DecoEntry[] {
  const out: DecoEntry[] = [];
  for (let ln = 1; ln <= doc.lines; ln++) {
    if (ln === activeLine) continue;
    const line = doc.line(ln);
    const m = TRAILING_BLOCK_ID.exec(line.text);
    if (!m) continue;
    // `m[1]` is the leading "" or single whitespace char; the caret
    // sits right after it. `1 + m[2].length` covers "^" + the id.
    const caretRel = m.index + m[1].length;
    const from = line.from + caretRel;
    const to = from + 1 + m[2].length;
    if (isInsideCode(tree, from)) continue;
    out.push({ from, to, kind: "mark-blockid" });
  }
  return out;
}
```

(d) Add the decoration object next to `tagMarkDeco`:

```ts
const blockIdMarkDeco = Decoration.mark({ class: "cm-md-blockid" });
```

(e) Add the `buildDecorationSet` case next to `"mark-tag"`:

```ts
      case "mark-blockid":
        ranges.push(blockIdMarkDeco.range(e.from, e.to));
        break;
```

(f) Merge `findBlockIds` into `buildFor`. Replace the body of `buildFor`:

```ts
function buildFor(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const head = view.state.selection.main.head;
  const activeLine = view.state.doc.lineAt(head).number;
  const resolver = view.state.facet(wikilinkResolverFacet);
  const entries = collectDecorations(
    tree,
    view.state.doc,
    activeLine,
    resolver ? (t) => resolver.get(t) : undefined,
  );
  const blockIds = findBlockIds(view.state.doc, tree, activeLine);
  return buildDecorationSet([...entries, ...blockIds]);
}
```

(g) Add the base-theme rule next to `.cm-md-tag` in `decorationBaseTheme`:

```ts
  ".cm-md-blockid": {
    color: "var(--c-fg-muted)",
    fontSize: "0.85em",
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/editor/decorations.test.ts`
Expected: PASS — the 5 new `findBlockIds` tests plus all pre-existing `collectDecorations` / `findFrontmatter` tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/decorations.ts ui/src/editor/decorations.test.ts
git commit -m "feat(ui): muted, fence-aware ^block-id live-preview decoration"
```

---

### Task 3: Editor gesture prop + keymap

**Files:**
- Modify: `ui/src/Editor.tsx`

- [ ] **Step 1: Import the byte-offset helper**

In `ui/src/Editor.tsx`, add near the other `./editor/*` imports (e.g. below the `autocompleteProvider` import at line ~35):

```ts
import { byteOffsetOf } from "./editor/blockRef";
```

- [ ] **Step 2: Add the `onCopyBlockRef` prop**

In `EditorProps` (after `onToggleRawSource?`, before `ref?`):

```ts
  /**
   * Fired by the block-reference keybind (`Cmd/Ctrl+Shift+B`). The
   * argument is the cursor's UTF-8 byte offset into the buffer; the
   * parent mints a block id at that line via `create_block_ref` and
   * copies a `[[…#^id]]` link to the clipboard.
   */
  onCopyBlockRef?: (byteOffset: number) => void;
```

- [ ] **Step 3: Add the keymap entry**

In the `keymap.of([...])` array, add this entry immediately after the `Mod-e` entry's closing `},` (before `...defaultKeymap,`):

```ts
            {
              key: "Mod-Shift-b",
              run: (view) => {
                const head = view.state.selection.main.head;
                const text = view.state.doc.toString();
                props.onCopyBlockRef?.(byteOffsetOf(text, head));
                return true;
              },
            },
```

- [ ] **Step 4: Verify it compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: clean (no type errors; the prop is optional and unused-at-callsite is fine until Task 4 wires it).

- [ ] **Step 5: Commit**

```bash
git add ui/src/Editor.tsx
git commit -m "feat(ui): Cmd/Ctrl+Shift+B editor gesture for block refs"
```

---

### Task 4: App orchestration + wire the prop

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Import the IPC + link builder**

In `ui/src/App.tsx`, add `createBlockRef` to the existing `./api/ipc` import group (the block ending `} from "./api/ipc";` at line ~30, alongside `writeFileText`, `readFileText`, etc.):

```ts
  createBlockRef,
```

And add the link-builder import near the other editor imports:

```ts
import { buildBlockRefLink } from "./editor/blockRef";
```

- [ ] **Step 2: Add the handler**

In the `App` component body, near `flushAutosave` / `reloadFromDisk` (after `flushAutosave` is defined, ~line 301), add:

```ts
  /**
   * "Copy block reference" gesture (L3 Session G). Flush the buffer so
   * disk bytes match the cursor offset, mint/reuse a `^id` at that line
   * via the backend (the sole minter), and copy the `[[path#^id]]` link.
   * The backend's disk write rides the silent-reload path to bring the
   * `^id` into the clean buffer — no conflict banner.
   */
  const handleCopyBlockRef = async (byteOffset: number): Promise<void> => {
    const id = vaultId();
    const path = selectedPath();
    if (!id || !path) return;
    try {
      await flushAutosave();
      const resp = await createBlockRef({
        vault_id: id,
        target_path: path,
        position: byteOffset,
      });
      await navigator.clipboard.writeText(
        buildBlockRefLink(path, resp.block_id),
      );
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
    }
  };
```

- [ ] **Step 3: Pass the prop to `<Editor>`**

In the `<Editor … />` JSX (~line 1166), add after `onBlur={...}`:

```tsx
                  onCopyBlockRef={(off) => void handleCopyBlockRef(off)}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): wire block-ref gesture through App (flush → mint → clipboard)"
```

---

### Task 5: Verification, docs, finish branch

**Files:**
- Modify: `docs/layer-3-spec.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Frontend gates**

```bash
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: tsc clean; vitest all green (was 268 + 11 new: 6 `blockRef` + 5 `findBlockIds`) = 279; build succeeds (the pre-existing chunk-size warning is fine).

- [ ] **Step 2: Rust suite unchanged (sanity)**

Run: `cargo test --workspace 2>&1 | tail -5`
Expected: PASS, 271 (no backend edits this session). (If `runner::tests::schema_too_new_is_rejected` trips, it's a known parallel-run flake — re-run in isolation.)

- [ ] **Step 3: Real-app smoke (best-effort)**

```bash
cargo build -p cubical-app
# then: cargo tauri dev, open a sandbox vault.
#  - Put the cursor on a paragraph, press Cmd/Ctrl+Shift+B.
#  - Confirm the clipboard holds `[[note#^id]]` (paste somewhere).
#  - Confirm `^id` was appended to the line in the .md on disk.
#  - Confirm the editor shows the id muted off the cursor line and raw
#    when the cursor is on that line.
#  - Paste the link into another note; confirm it resolves (not dashed).
#  - Confirm a `^id` typed inside a ``` fence is NOT muted.
```
The native Tauri window can't be browser-driven in this automated context (same constraint as Sessions D–G). Record the smoke honestly: the pure logic (offset conversion, link building, decoration scanning incl. fence-skip + active-line reveal) is fully unit-tested; the flush→IPC→clipboard glue is thin and exercised end-to-end only by the hands-on smoke.

- [ ] **Step 4: Update docs + state**

- Add `### 9.9 Session G frontend follow-up — block-ref gesture + ^id decoration` to `docs/layer-3-spec.md` §9 (mirror §9.8 style): the `Cmd/Ctrl+Shift+B` gesture (flush → `create_block_ref` → clipboard, backend remains sole minter, silent-reload brings `^id`), the byte-offset contract, the path-minus-`.md` link form, and the fence-aware muted `^id` decoration (direct scan, revealed on the cursor line). Note what stays deferred: broken-ref status bar + `[[#^` autocomplete.
- Rewrite the `CLAUDE.md` "Project state" block (do not append): Session G frontend done; update the vitest count (279) and Rust count (271 unchanged); set "Next: L3 Session G remaining follow-ups — broken block-ref status bar (+ status-bar shell) and `[[#^` autocomplete (needs a backend ids-in-file query); then Session H — Embeds."

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **Backend stays the sole minter.** The gesture never writes `^id` itself — it computes a byte offset and calls `create_block_ref`. The `^id` lands in the buffer via the existing silent-reload path, not a frontend insert. Do not "optimize" this into a local CM transaction; that would duplicate the id grammar and break the invariant.
- **`flushAutosave()` before the IPC is load-bearing.** It guarantees disk bytes == buffer bytes at the cursor offset AND leaves the buffer clean so the backend's write reloads silently instead of raising a conflict banner.
- **Byte vs char offset.** CM positions are UTF-16 code units; `create_block_ref` wants UTF-8 byte offsets. `byteOffsetOf` is the only place this conversion happens — keep it there.
- **Decoration grammar must match the Rust scanner** (`^` + `[A-Za-z_][A-Za-z0-9_-]*`, end-of-line, whitespace/start before `^`, fence-skip). If the backend grammar ever changes, change `TRAILING_BLOCK_ID` too.
- **Merge order into `buildDecorationSet` is safe** — `Decoration.set(ranges, true)` sorts. No need to interleave `findBlockIds` output with `collectDecorations` output.
- **Out of scope, on purpose:** broken block-ref status bar, the status-bar shell, `[[#^` in-bracket block-id autocomplete, block embeds (Session H). `getBrokenBlockRefs` stays unused until the status-bar session.
```
