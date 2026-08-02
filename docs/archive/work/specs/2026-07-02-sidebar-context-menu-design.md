> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Sidebar right-click: create/delete files and folders

**Date:** 2026-07-02
**Status:** Design — approved, pre-implementation
**Surface:** Left sidebar file tree in `ui/src/App.tsx`; new backend command in `crates/cubical-engine`

## Problem

The sidebar already has a right-click context menu, but it's file-rows-only and
offers a single item ("Rename…"). There's no way to create a file/folder or
delete one from the sidebar — creation IPC (`create_file`, `create_file_at_path`,
`create_folder`) exists and is unused by any UI trigger, and no delete/trash
command exists anywhere in the engine.

## Goal

Right-click a folder row or empty space below the tree to create a file/folder
inside it (or at vault root, for empty space). Right-click any row (file or
folder) to delete it, with confirmation, to the OS trash.

## Backend

New command `delete_path` in `crates/cubical-engine/src/commands/vault.rs`,
alongside `create_file`/`create_folder`/`rename_file`. Takes a vault-relative
path, resolves it under the vault root, and calls the `trash` crate's
`delete()` — a new workspace dependency (`workspace.dependencies` in the root
`Cargo.toml`). `trash::delete` moves a directory and its full contents to the
OS trash/recycle bin in one call, so no manual recursion is needed on our side.

Register the command in `crates/cubical-app/src/lib.rs`'s `generate_handler!`
list, same as the other vault commands. No new event plumbing: the existing
file-watcher already detects the removal and drives the tree/index update, the
same path that already handles external deletes (e.g. via Finder) while the
app is open.

Error cases (path outside vault, path already gone, trash unavailable on the
platform) return `Result<(), String>` like the sibling commands and surface to
the frontend as a rejected promise.

## Frontend

### Context menu targets

Extend the existing `contextMenu` signal/render block (currently file-rows
only) to also fire on:
- **Folder rows** — menu: New File, New Folder, Delete (**no Rename** — see
  "Folder rename is out of scope" below)
- **Empty space** below the last row — menu: New File, New Folder (scoped to
  vault root)
- **File rows** — unchanged Rename, **+ Delete** (new)

### Folder rename is out of scope

`rename_file` (`crates/cubical-engine/src/commands/rename.rs`) only operates
on rows in the `files` table and rejects with `FileNotFound` for anything
else — there is no backend support for renaming a folder today. A real
`rename_folder` would need to cascade the path-prefix change across every
file nested under the folder (and everywhere those paths are referenced —
`links`, `tags`, `backlinks`), which is close in size to `rename_file`'s own
referrer-rewriting machinery, just applied per-file across a subtree. That's
a separate future spec, not part of this one.

Practical effect: folder rows get New File / New Folder / Delete only.
"New Folder" (whether triggered from a folder row or empty space) creates
the folder with its collision-safe `Untitled Folder` name and does **not**
auto-enter rename mode — it just appears in the tree, matching the existing
toolbar "new folder" button's behavior. Only "New File" auto-enters rename
mode, since files already support renaming today.

### Create flow

New File / New Folder click calls the existing `createFile`/`createFolder` IPC
wrapper in `ui/src/api/ipc.ts`, scoped to the right-clicked folder's path (or
`""` for vault root/empty-space). Both commands already return a collision-safe
name (`Untitled.md`, `Untitled Folder`). For **New File**, once the new row
appears in the tree, immediately set `renamingPath` to it — reusing the
existing inline F2-style rename input (autofocus, Enter commits, Escape
cancels) so the user types the real name in one motion: right-click → New
File → type name → Enter. **New Folder** does not enter rename mode (see
"Folder rename is out of scope" above) — it just refreshes the tree so the
new `Untitled Folder` appears.

If creation fails, show an error toast (existing `Toast` component) and skip
entering rename mode.

### Delete flow

New `deleteFile` wrapper in `ui/src/api/ipc.ts` calling `delete_path`. Delete
click opens a new hand-rolled confirm dialog (no confirm/modal component
exists yet in this codebase — everything is inline JSX in `App.tsx`, so this
follows that convention rather than introducing a UI library):

- File: "Delete 'notes.md'?"
- Folder: "Delete 'projects' and its N files?" — N computed from the existing
  in-memory tree data (count of `FileLeaf`s under the folder node), no extra
  IPC round-trip.

Confirm calls `deleteFile`; buttons disable while the call is in-flight to
prevent double-submit. Cancel, Escape, or backdrop click dismisses with no
action. On IPC failure, show an error toast and leave the item in place.

## Out of scope

- Multi-select delete/create.
- Undo (relies entirely on OS trash for recovery).
- Any change to the rename durability journal — deletes are not renames, and a
  deleted file's dangling referrer links are the same class of problem the
  vault already tolerates for any external deletion while the app is closed.

## Testing

- Rust: unit tests for `delete_path` in a temp vault dir — single file, folder
  with nested contents, error on missing/out-of-vault path. Confirm `trash`
  works headlessly in CI (targets the XDG trash spec on Linux via
  `~/.local/share/Trash`, no desktop session required) when wiring up the test.
- TS: this is UI wiring in `App.tsx`, covered by operator-smoke per existing
  convention for this file (same as the current Rename flow) rather than new
  unit tests. Any new pure logic extracted (e.g. the folder child-count
  helper) gets a unit test.
- Manual/preview verification: right-click each target (file, folder, empty
  space) in the running app; create → auto-rename → Enter; delete → confirm →
  item disappears from tree and lands in OS trash.
