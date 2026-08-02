> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session G — Frontend follow-up: block-reference gesture + `^id` decoration (design)

**Date:** 2026-05-29
**Layer:** 3 — Knowledge Graph
**Depends on:** Session G backend core (merged to `main`, spec §9.8) — migration 005, `create_block_ref` / `get_broken_block_refs` commands, and the `createBlockRef` / `getBrokenBlockRefs` IPC bindings already in `ui/src/api/ipc.ts`.

## Goal

Close the block-reference feature into something a user can see and use in the editor: a **"Copy block reference" gesture** that mints a `^block-id` for the line under the cursor and copies a `[[path#^id]]` wiki-link to the clipboard, and a **`^id` live-preview decoration** so the minted id reads as an intentional anchor instead of stray trailing text.

Frontend-only. No new backend code — both features reuse IPC that shipped with the backend core.

## Scope

**In:**
1. Copy block-reference gesture (editor command → `create_block_ref` → clipboard).
2. `^id` live-preview decoration (muted off the cursor line, raw on it; fence-aware).

**Out (each its own later session):**
- Broken block-ref **status bar** — needs a greenfield status-bar shell (no status bar exists in the app yet); a separate vault-health surface. `getBrokenBlockRefs` stays unused until then.
- **`[[#^` in-bracket autocomplete** — needs a new backend "block-ids in a file" query, so it isn't frontend-only; belongs with an autocomplete-extension session.
- Any interactive "insert into another note" picker. The gesture is copy-to-clipboard + manual paste, matching Obsidian's "Copy link to block."

## Background — relevant existing machinery

- **Save model (`App.tsx`).** 300ms autosave debounce; `flushAutosave()` persists the buffer via `writeFileText` and records `lastWrittenHash` / `seenHash`. A `dirty` flag tracks unsaved edits.
- **External-edit handling (`App.tsx` `onVaultFileChanged`, ~line 617–654).** When the open file changes on disk: own-write echoes (`incoming === lastWrittenHash`) are dropped; otherwise a **clean** buffer **silently reloads** (`editorApi.replaceContent`), and a **dirty** buffer raises a conflict banner. This is the mechanism that brings a backend-written `^id` back into the editor.
- **Decorations (`ui/src/editor/decorations.ts`).** `collectDecorations(tree, doc, activeLine, …)` is the pure, Lezer-driven core producing a flat `DecoEntry[]`; `buildDecorationSet` maps kinds → CM6 decorations; `livePreviewPlugin` rebuilds on doc/selection/parse changes. Frontmatter is the precedent for a **non-Lezer** decoration found by scanning the doc directly (`findFrontmatter`). Block IDs are explicitly called out as "L3+ territory, left raw" (decorations.ts:30). Markers reveal raw on the cursor line (`mark-marker-muted`) and hide/transform off it.
- **Code-context gating (`ui/src/editor/autocomplete.ts` `isInhibited`).** Walks the Lezer ancestor chain to reject positions inside `FencedCode`/`CodeText`/`InlineCode`/etc. The decoration scan reuses this idea to skip `^id` inside code.
- **Editor command wiring (`Editor.tsx`).** A `keymap.of([...])` already binds `Mod-e`. Callback props (`onToggleRawSource`, `onContentChange`, `onBlur`) are the established Editor→App seam.
- **Wiki-link target resolution (`cubical-core::vault::links::resolve_target`).** Accepts an exact vault-relative path (with/without `.md`), then unique case-insensitive basename. A path-minus-`.md` target is therefore an unambiguous exact match even when basenames collide.

## Feature 1 — Copy block-reference gesture

### Flow

1. User places the cursor anywhere on a line in the open note and invokes the command (default keybinding **`Mod-Shift-b`**; no clash with `Mod-e`).
2. The editor keymap reads the selection head, converts it to a **UTF-8 byte offset** (CodeMirror positions are UTF-16 code-unit offsets into the JS string; convert with `TextEncoder().encode(text.slice(0, head)).length`), and calls a new prop `onCopyBlockRef(byteOffset)`.
3. The App handler:
   - `await flushAutosave()` — persists the buffer to disk so the on-disk bytes match the buffer at `byteOffset`. (No-op for a clean buffer.)
   - `createBlockRef({ vault_id, target_path: openPath, position: byteOffset })` — backend mints/reuses the `^id`, rewrites the file on disk, returns `block_id`.
   - Build the wiki-link `[[<openPath-without-.md>#^<block_id>]]` and write it to the clipboard via `navigator.clipboard.writeText`.
4. The backend's disk write fires `vault:file-changed` with a new content hash. The buffer is clean (just flushed), so the **existing silent-reload path** pulls the file — now containing `^id` — back into the editor. No conflict banner.

### Why backend-authoritative

`create_block_ref` is the **sole minter** of block ids (the headline invariant of the backend core). A frontend-only approach — inserting `^id` directly via a CM transaction — would duplicate the deterministic id grammar in TypeScript and bypass that invariant. So the gesture computes the offset and delegates minting to the backend; the silent-reload path reconciles the buffer.

### Edge cases

- **Dirty buffer at invocation:** `flushAutosave()` writes first (echo suppressed via `lastWrittenHash`), then `create_block_ref` writes (a distinct new hash, buffer now clean) → silent reload. Two writes, no conflict banner.
- **Line already has an id:** `create_block_ref` is idempotent — returns the existing id, no source change. The clipboard still gets a correct ref; the (no-op) disk write's echo is harmless.
- **Non-ASCII before the cursor:** byte-offset conversion (not char offset) keeps the backend's line-locating correct.
- **No note open / no vault:** the command is a no-op (guard in the App handler).
- **Clipboard unavailable in WKWebView:** `navigator.clipboard.writeText` is the first choice; if it proves unavailable in the production webview, fall back to the Tauri clipboard plugin. Flagged as an implementation-time verification, not a design fork.

### Components / seam

- `Editor.tsx`: add a keymap entry that computes the byte offset and invokes `props.onCopyBlockRef?.(byteOffset)`.
- `App.tsx`: implement `onCopyBlockRef`, passed to `<Editor>`. Orchestrates flush → IPC → clipboard, guarded on `vaultId()` + `selectedPath()`.
- Pure helpers (own module, e.g. `ui/src/editor/blockRef.ts`): `byteOffsetOf(text, charPos)` and `buildBlockRefLink(path, blockId)` — both unit-tested.

## Feature 2 — `^id` live-preview decoration

### Behavior

A trailing block id on a line renders **muted and smaller** off the cursor line (a `cm-md-blockid` class), and is **revealed raw on the cursor line** — identical to how every marker behaves, so the id stays directly editable. Ids inside fenced or inline code are left completely raw (never decorated).

### Detection (not Lezer)

The markdown grammar doesn't model `^id`, so — like `findFrontmatter` — a dedicated pure function scans the doc:

`findBlockIds(doc, tree, activeLine): DecoEntry[]`
- For each line, regex-match a trailing `(?:^|\s)\^[A-Za-z_][A-Za-z0-9_-]*\s*$` (the same grammar the Rust scanner and minter use — must stay in lockstep).
- Skip the match if its position resolves inside `FencedCode`/`CodeBlock`/`InlineCode`/`CodeText` per the syntax tree (reuse the `isInhibited` ancestor-walk approach).
- Off the active line → emit a `mark-blockid` entry over the `^id` range; on the active line → emit nothing (the line renders raw, like other markers).

### Integration

- Add `"mark-blockid"` to `DecoKind`, a `cm-md-blockid` `Decoration.mark`, a `buildDecorationSet` case, and a base-theme rule (muted color + `~0.85em`, mirroring `cm-md-mark-muted`).
- Call `findBlockIds` from `buildFor` and concatenate its entries into the set the plugin already builds (alongside `collectDecorations`). `findBlockIds` lives in `decorations.ts` (it is a decoration concern) and is unit-tested in `decorations.test.ts`.

### Why a separate scan rather than extending `collectDecorations`

`collectDecorations` is strictly Lezer-driven by contract. `^id` has no Lezer node, so folding it in would break that contract. A parallel pure scanner (the frontmatter precedent) keeps each function single-purpose and independently testable.

## Data flow summary

```
Gesture:  cursor → Editor keymap → byteOffset → App.onCopyBlockRef
          → flushAutosave → createBlockRef IPC (disk write + row) → clipboard
          → vault:file-changed → silent reload → ^id visible in buffer

Decoration: doc/selection change → livePreviewPlugin.buildFor
          → collectDecorations (Lezer) + findBlockIds (direct scan)
          → DecorationSet → muted ^id off cursor line, raw on it
```

## Testing

- **Pure unit tests (vitest):**
  - `byteOffsetOf` — ASCII and multi-byte (e.g. emoji, accented chars) before the cursor.
  - `buildBlockRefLink` — `.md` stripping, nested path.
  - `findBlockIds` — trailing id, id on its own line, fenced-code skip, inline-code skip, active-line reveal (no entry), no-id line.
- **Orchestration:** flush→IPC→clipboard is thin glue over already-tested pieces; covered by a hands-on smoke (consistent with prior frontend sessions' smoke notes — the native Tauri window can't be browser-driven in this automated context).
- **Gates:** `npx tsc --noEmit`, `npx vitest run`, `npm run build`, plus the Rust suite unchanged (no backend edits).

## Smoke plan (hands-on, when a machine is available)

In `cargo tauri dev` against a sandbox vault: open a note, put the cursor on a paragraph, press `Mod-Shift-b`; confirm (a) the clipboard holds `[[note#^id]]`, (b) `^id` appears in the `.md` on disk, (c) the editor shows the id muted off the cursor line and raw on it, (d) paste the ref into another note and confirm it resolves, (e) no `^id` is decorated inside a code fence.

## Out-of-scope / follow-ups (unchanged from §9.8)

- Broken block-ref status bar (+ the status-bar shell).
- `[[#^` in-bracket block-id autocomplete (needs a backend ids-in-file query).
- Session H — Embeds (`![[…]]` / `![[#^id]]`).
