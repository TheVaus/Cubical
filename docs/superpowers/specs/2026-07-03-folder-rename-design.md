# Folder rename

**Date:** 2026-07-03
**Status:** Design — approved, pre-implementation
**Surface:** New engine command in `crates/cubical-engine`; sidebar context menu in `ui/src/App.tsx`

## Problem

Folder rename was explicitly scoped out of the sidebar right-click feature
(`docs/superpowers/specs/2026-07-02-sidebar-context-menu-design.md`, "Folder
rename is out of scope") because `rename_file` only operates on rows in the
`files` table and rejects anything not tracked there — there's no backend
support for renaming a folder today. Folder rows currently get New File /
New Folder / Delete only.

## Goal

Right-click a folder row → Rename… → inline-edit its name, same gesture as
file rename today. Every file and subfolder nested under it moves with it,
with the same referrer-link durability guarantees single-file rename
already has (deferred rewrite queue, journal, broken-link repair).

## Backend

### Shared per-file rekey helper

`rename_file`'s core logic — rekey one file's FK rows
(`links.source_path`/`target_path`, `tags.file_path`, `blocks.file_path`,
`block_refs.source_file_path`/`target_file_path`, `frontmatter.file_path`)
and update its `files.path` — gets extracted from
`crates/cubical-engine/src/commands/rename.rs` into a standalone function
taking an open transaction, a `from` path, and a `to` path. `rename_file`
calls it once inside its existing transaction; `rename_folder` calls it once
per file under the old prefix, inside **one new transaction covering the
whole subtree** — not N separate transactions, so a folder rename is atomic
even if it touches hundreds of files.

This is a refactor of existing, already-tested code, not new logic — a
regression test confirms `rename_file`'s behavior is byte-for-byte
unchanged after the extraction.

### `rename_folder(vault_id, from_path, to_path)`

New command in `crates/cubical-engine/src/commands/rename.rs`, alongside
`rename_file`.

1. **Validate**: `from_path` is a tracked row in the `folders` table
   (`SELECT 1 FROM folders WHERE path = ?1`, mirroring `rename_file`'s
   `files`-table tracked-check); `to_path` doesn't collide with any existing
   file or folder; both paths pass the same `normalize_rel_file_path`-style
   segment validation `rename_file` already uses (rejects `..`, `.`, empty
   segments) — **except** folder names skip `isValidNoteName`'s dot
   restriction, since that rule exists specifically to keep file names
   `[[note.prop]]`-linkable and doesn't apply to folders (folders aren't
   referenced via wiki-link syntax).
2. **One transaction**:
   - `SELECT path FROM files WHERE path = ?from_path OR path LIKE ?from_path || '/%'` — every file in the subtree.
   - For each, compute the prefix-swapped new path
     (`to_path + stripped_suffix`) and call the shared rekey helper.
   - `SELECT path FROM folders WHERE path = ?from_path OR path LIKE ?from_path || '/%'` — the folder itself plus every nested subfolder.
   - For each, `UPDATE folders SET path = ?new WHERE path = ?old`.
3. **Commit**, then move the directory **on disk as a single atomic move**
   (`std::fs::rename`, same cross-filesystem fallback `rename_file` already
   has for `atomic_write` + remove) — not per-file moves. One filesystem
   operation relocates every nested file and subfolder together.
4. **Per renamed file** (post-commit, same ordering `rename_file` uses):
   re-extract frontmatter/links/tags/blocks/block_refs from on-disk content
   at the new path (these tables are keyed by path, so a stale extraction
   would point at the old location); sync the search index (delete old
   path's Tantivy doc, re-add at the new path); append one
   `.cubical/renames.jsonl` entry (reusing the existing `"file"` journal
   kind — no new kind, no changes to the replay/prune logic); run broken-link
   repair if `wikilinks.rewrite_broken_links_on_rename` is on.

Referrer text rewrites stay on the existing deferred path: each renamed
file's referrers get enqueued into `pending_rewrites` exactly like
single-file rename, flushed later by the same timer/close/manual-flush
triggers. No new flush timing logic.

### Error cases

`Result<(), CubicalError>` (no response payload, matching `rename_file`'s
sibling shape where applicable) — `InvalidRequest` for validation failures
(untracked folder, destination collision, invalid path segments),
propagating the same error variants `rename_file` uses elsewhere in the
transaction (DB errors, I/O errors on the directory move).

## Frontend

### Context menu

Folder rows gain **Rename…**, alongside the existing New File / New Folder
/ Delete. Same position/style as the file row's Rename… item.

### Inline rename input

The folder row gets the same `<Show when={isRenaming()}>` swap-to-input
treatment the file row already has (autofocus, Enter commits, Escape
cancels) — currently file-only in `ui/src/App.tsx`, extended to folders.

### Commit flow

The rename-commit handler needs to know whether the path being renamed is a
file or a folder (different IPC call: `renameFile` vs. a new `renameFolder`
wrapper). Determined by looking up the path's `kind` in `treeRows()` at
commit time — no new signal needed.

Validation mirrors the existing empty/unchanged checks
(`validateRenameTarget`) but skips the dot restriction for folders, per the
backend's validation rule above.

### Open-file follows the rename

If `selectedPath()` starts with `fromPath + "/"`, rewrite it with the prefix
swapped to the new folder path — mirrors the existing exact-match check
single-file rename already does (`if (selectedPath() === fromPath)
setSelectedPath(target)`), widened to a prefix check since the affected file
can be nested arbitrarily deep under the renamed folder. Without this, an
open file inside a just-renamed folder would autosave to a path that no
longer exists.

### Errors

Surface through the existing toast pattern (`showToast(errorMessage(e))`),
same as every other rename/create/delete flow in this file.

## Out of scope

- **Move** (dragging a folder into a different parent) — this spec is
  *rename in place*: same parent, new name. A target name containing `/` is
  rejected as an invalid name, not treated as a move.
- Multi-select rename.
- Any change to the rename durability journal's schema or replay logic —
  folder rename reuses the existing per-file `"file"`-kind journal entries
  unchanged.

## Testing

- Rust: `rename_folder` unit tests — happy path (files at multiple nesting
  depths and a nested subfolder all correctly rekeyed; referrer links to a
  nested file still resolve after rename), destination-collision rejection,
  path-escape rejection, untracked-folder rejection, broken-link repair
  still runs per file when the setting is on.
- Rust: a regression test asserting `rename_file`'s behavior (its existing
  test suite) is unchanged after the shared-helper extraction — the
  refactor must not alter single-file rename's behavior.
- TS: any new pure logic (e.g. the prefix-swap helper computing the new
  `selectedPath`) gets a unit test, matching the existing
  `renameTarget`/`validateRenameTarget` pattern. The interactive wiring
  itself stays operator-smoke-only, consistent with the rest of this file's
  rename/context-menu UI.
- Manual smoke: rename a folder containing nested files and a nested
  subfolder while one of the nested files is open in the editor — confirm
  the editor follows the rename (no broken autosave), the sidebar tree
  updates, and backlinks pointing at files inside the renamed folder still
  resolve.
