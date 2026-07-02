# Sidebar Right-Click Create/Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click a folder row or empty sidebar space to create a file/folder inside it; right-click any row to delete it (with confirmation) to the OS trash.

**Architecture:** One new engine command (`delete_path`, backed by the `trash` crate) plumbed through the existing Tauri-shim pattern. On the frontend, the existing file-rows-only context menu (currently one item: Rename) grows a `kind` field (`"file" | "folder" | "empty"`) and branches its menu items accordingly; a new hand-rolled confirm dialog gates delete.

**Tech Stack:** Rust (`cubical-engine`, `cubical-app`), `trash` crate v5, Solid.js/TypeScript (`ui/src/App.tsx`, `ui/src/sidebar/fileTree.ts`, `ui/src/api/ipc.ts`).

## Global Constraints

- Folder rename is explicitly out of scope (see spec's "Folder rename is out of scope" section) — folder rows get New File / New Folder / Delete only, no Rename.
- Delete moves to the OS trash via the `trash` crate — never a hard unlink.
- Delete always shows a confirm dialog first, even though trash is recoverable.
- No new `vault:file-changed`-adjacent event plumbing for delete — the existing file-watcher already detects removals (same path as an external Finder delete) and drives the tree refresh.
- Spec: `docs/superpowers/specs/2026-07-02-sidebar-context-menu-design.md`.

---

### Task 1: Backend — `delete_path` engine command + Tauri wiring

**Files:**
- Modify: `Cargo.toml:37-38` (workspace deps — add `trash` after `tempfile`)
- Modify: `crates/cubical-engine/Cargo.toml` (add `trash = { workspace = true }` to `[dependencies]`)
- Modify: `crates/cubical-engine/src/api/types.rs` (add `DeletePathRequest`, after `CreateFolderResponse`)
- Modify: `crates/cubical-engine/src/commands/vault.rs` (add `delete_path` handler + tests, after `create_folder`)
- Modify: `crates/cubical-app/src/lib.rs` (register the Tauri shim)

**Interfaces:**
- Consumes: `normalize_rel_file_path(path: &str) -> Result<String, CubicalError>` and `clone_vault(state: &AppState, vault_id: &str) -> Result<Vault, CubicalError>` — both already exist in `vault.rs`.
- Produces: `pub async fn delete_path(state: &AppState, req: DeletePathRequest) -> Result<(), CubicalError>` — Task 3's frontend calls this indirectly via the `deleteFile` IPC wrapper Task 2 builds.

- [ ] **Step 1: Add the `trash` dependency**

In `Cargo.toml`, in `[workspace.dependencies]`, insert immediately after the `tempfile = "3"` line (before the `# uuid + filetime...` comment):

```toml
# OS trash/recycle bin — delete_path moves files/folders here instead of
# unlinking, so a sidebar delete is recoverable.
trash = "5"
```

In `crates/cubical-engine/Cargo.toml`, in `[dependencies]`, insert after the `sha2 = { workspace = true }` line:

```toml
# OS trash/recycle bin — see delete_path in commands/vault.rs.
trash = { workspace = true }
```

- [ ] **Step 2: Write the failing tests**

In `crates/cubical-engine/src/commands/vault.rs`, inside `mod tests` (the module starting at `#[cfg(test)] mod tests {`), add these four tests immediately after the `create_folder_makes_untitled_folder_and_tracks_it` test (i.e. right before the `/// Insert a \`files\` row...` doc comment that precedes `seed_file_with_frontmatter`):

```rust
    #[tokio::test]
    async fn delete_path_removes_a_file() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        std::fs::write(dir.path().join("note.md"), "body\n").unwrap();

        delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect("delete");

        assert!(!dir.path().join("note.md").exists());
    }

    #[tokio::test]
    async fn delete_path_removes_a_folder_with_contents() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        std::fs::create_dir_all(dir.path().join("projects/nested")).unwrap();
        std::fs::write(dir.path().join("projects/a.md"), "a\n").unwrap();
        std::fs::write(dir.path().join("projects/nested/b.md"), "b\n").unwrap();

        delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "projects".into(),
            },
        )
        .await
        .expect("delete folder");

        assert!(!dir.path().join("projects").exists());
    }

    #[tokio::test]
    async fn delete_path_rejects_missing_path() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "ghost.md".into(),
            },
        )
        .await
        .expect_err("must reject a path that doesn't exist");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn delete_path_rejects_escape() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "../evil.md".into(),
            },
        )
        .await
        .expect_err("must reject ..");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }
```

- [ ] **Step 3: Run the tests to verify they fail (compile error)**

Run: `cargo test -p cubical-engine delete_path`
Expected: compile error — `cannot find function \`delete_path\` in this scope` and `cannot find struct \`DeletePathRequest\``. This is the correct RED for a wholly new Rust function: there's no runtime test to fail yet because the code doesn't exist.

- [ ] **Step 4: Add the `DeletePathRequest` type**

In `crates/cubical-engine/src/api/types.rs`, insert immediately after the `CreateFolderResponse` struct (after its closing `}`, before the `/// Per-file row returned by \`list_files\`.` doc comment):

```rust
/// Request payload for `delete_path`.
#[derive(Debug, Clone, Deserialize)]
pub struct DeletePathRequest {
    /// Vault to delete from.
    pub vault_id: String,
    /// Vault-relative path of the file or folder to delete.
    pub path: String,
}
```

No response type — mirrors `CloseVaultRequest`/`CancelVaultScanRequest`, which return `Result<(), CubicalError>` with no payload.

- [ ] **Step 5: Implement `delete_path`**

In `crates/cubical-engine/src/commands/vault.rs`, add `DeletePathRequest` to the `use crate::api::types::{...}` import block (alphabetically, after `CreateFolderResponse`):

```rust
use crate::api::types::{
    CancelVaultScanRequest, CloseVaultRequest, CreateFileAtPathRequest, CreateFileAtPathResponse,
    CreateFileRequest, CreateFileResponse, CreateFolderRequest, CreateFolderResponse,
    DeletePathRequest, FileEntry, FrontmatterEntry, GetCanonicalAstRequest,
    GetCanonicalAstResponse, GetFrontmatterRequest, GetFrontmatterResponse, GetSettingRequest,
    GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse, ListFilesRequest,
    ListFilesResponse, OpenVaultRequest, OpenVaultResponse, ReadFileTextRequest,
    ReadFileTextResponse, ReloadSettingsRequest, ReloadSettingsResponse, ScanStatus,
    SetSettingRequest, SetSettingResponse, WriteFileTextRequest, WriteFileTextResponse,
};
```

Then add the handler immediately after `create_folder` (after its closing `}`, before the `/// Read the parsed frontmatter index for one file.` doc comment):

```rust
/// `delete_path` — move a file or folder to the OS trash/recycle bin.
///
/// No index/tree update happens here: the vault's file-watcher already
/// detects the removal (the same path that handles an external delete via
/// Finder while the app is open) and drives the `files`/`folders` cleanup
/// and the `vault:file-changed` refresh. `trash::delete` moves a
/// directory's full contents in one call — no manual recursion needed.
pub async fn delete_path(state: &AppState, req: DeletePathRequest) -> Result<(), CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let rel_path = normalize_rel_file_path(&req.path)?;
    let abs_path = vault.root().join(&rel_path);
    if !abs_path.exists() {
        return Err(CubicalError::InvalidRequest(format!(
            "path does not exist: {rel_path}"
        )));
    }
    tokio::task::spawn_blocking(move || trash::delete(&abs_path))
        .await
        .map_err(|e| CubicalError::Io(format!("delete_path task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;
    Ok(())
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p cubical-engine delete_path`
Expected: 4 passed (`delete_path_removes_a_file`, `delete_path_removes_a_folder_with_contents`, `delete_path_rejects_missing_path`, `delete_path_rejects_escape`).

Then run the full engine suite to confirm no regressions: `cargo test -p cubical-engine`
Expected: all tests pass (555+ tests, per `CLAUDE.md`'s current count, plus the 4 new ones).

- [ ] **Step 7: Register the Tauri shim**

In `crates/cubical-app/src/lib.rs`, add `DeletePathRequest` to the `use cubical_engine::api::types::{...}` import block (alphabetically, after `DataviewResult`):

```rust
use cubical_engine::api::types::{
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse, CancelVaultScanRequest,
    CloseVaultRequest, CreateBlockRefRequest, CreateBlockRefResponse, CreateFileAtPathRequest,
    CreateFileAtPathResponse, CreateFileRequest, CreateFileResponse, CreateFolderRequest,
    CreateFolderResponse, DataviewQueryRequest, DataviewResult, DeletePathRequest,
    FlushPendingRewritesForTargetRequest, FlushPendingRewritesRequest,
    FlushPendingRewritesResponse, GetBacklinksRequest, GetBacklinksResponse,
    GetBrokenBlockRefsRequest, GetBrokenBlockRefsResponse, GetCanonicalAstRequest,
    GetCanonicalAstResponse, GetEmbedRequest, GetEmbedResponse, GetFrontmatterRequest,
    GetFrontmatterResponse, GetPendingRewritesBreakdownRequest,
    GetPendingRewritesBreakdownResponse, GetPendingRewritesCountRequest,
    GetPendingRewritesCountResponse, GetPropertyRequest, GetPropertyResponse, GetSettingRequest,
    GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse, LinkAutocompleteRequest,
    LinkAutocompleteResponse, ListFilesRequest, ListFilesResponse, ListRecentRenameOpsRequest,
    ListRecentRenameOpsResponse, ListTagsRequest, ListTagsResponse, OpenVaultRequest,
    OpenVaultResponse, QueryTagPageRequest, QueryTagPageResponse, ReadFileTextRequest,
    ReadFileTextResponse, ReloadSettingsRequest, ReloadSettingsResponse, RenameBlockIdRequest,
    RenameBlockIdResponse, RenameFileRequest, RenameFileResponse, RenameTagRequest,
    RenameTagResponse, ResolveLinkRequest, ResolveLinkResponse, SearchHealthDto,
    SearchIndexStatusDto, SearchRequest, SearchResponse, SearchVaultRequest, SetSettingRequest,
    SetSettingResponse, TagAutocompleteRequest, TagAutocompleteResponse, UndoRenameRequest,
    UndoRenameResponse, WriteFileTextRequest, WriteFileTextResponse,
};
```

Add `delete_path,` to the `tauri::generate_handler![...]` list, immediately after `create_folder,`:

```rust
            create_file,
            create_file_at_path,
            create_folder,
            delete_path,
            get_frontmatter,
```

Add the shim function immediately after the `create_folder` shim (after its closing `}`, before the `/// Tauri shim — see [\`commands::vault::get_frontmatter\`].` doc comment):

```rust
/// Tauri shim — see [`commands::vault::delete_path`].
#[tauri::command]
async fn delete_path(
    state: tauri::State<'_, AppState>,
    req: DeletePathRequest,
) -> Result<(), CubicalError> {
    commands::vault::delete_path(state.inner(), req).await
}
```

- [ ] **Step 8: Verify the whole workspace builds and tests pass**

Run: `cargo check --workspace`
Expected: no errors (confirms the shim compiles and the `generate_handler!` macro accepts the new command).

Run: `cargo test --workspace`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml crates/cubical-engine/Cargo.toml crates/cubical-engine/src/api/types.rs crates/cubical-engine/src/commands/vault.rs crates/cubical-app/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(engine): add delete_path — move a file/folder to the OS trash

New command alongside create_file/create_folder/rename_file. No new
index plumbing: the existing file-watcher already detects the removal
(same path as an external Finder delete) and drives the tree refresh.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend — `deleteFile` IPC wrapper + `countFilesUnderFolder` helper

**Files:**
- Modify: `ui/src/api/ipc.ts` (add `DeleteFileRequest` interface + `deleteFile` wrapper)
- Modify: `ui/src/sidebar/fileTree.ts` (add `countFilesUnderFolder`)
- Modify: `ui/src/sidebar/fileTree.test.ts` (tests for `countFilesUnderFolder`)

**Interfaces:**
- Consumes: `FolderNode`, `buildFileTree` — already exported from `fileTree.ts`.
- Produces: `deleteFile(req: DeleteFileRequest): Promise<void>` from `ipc.ts`; `countFilesUnderFolder(root: FolderNode, folderPath: string): number` from `fileTree.ts`. Task 3 imports both.

- [ ] **Step 1: Add the `deleteFile` IPC wrapper**

In `ui/src/api/ipc.ts`, add the request interface immediately after `CreateFolderResponse` (after its closing `}`, before the `CloseVaultRequest` interface):

```ts
export interface DeleteFileRequest {
  vault_id: string;
  path: string;
}
```

Add the wrapper function immediately after the `createFolder` function (after its closing `}`, before `closeVault`):

```ts
export function deleteFile(req: DeleteFileRequest): Promise<void> {
  return invoke("delete_path", { req });
}
```

This wrapper has no dedicated test — matches the existing convention for `createFile`/`createFolder`/`renameFile`, which are also untested thin `invoke()` forwarders (there is no `ipc.test.ts`; only wrappers with real parsing/query-building logic, like `search.ts`/`dataview.ts`, have tests).

- [ ] **Step 2: Write the failing tests for `countFilesUnderFolder`**

In `ui/src/sidebar/fileTree.test.ts`, add `countFilesUnderFolder` to the import from `./fileTree`:

```ts
import {
  buildFileTree,
  buildStableTreeRows,
  countFilesUnderFolder,
  flattenTree,
} from "./fileTree";
```

Add a new `describe` block at the end of the file (after the closing `});` of `describe("buildStableTreeRows", ...)`):

```ts
describe("countFilesUnderFolder", () => {
  it("counts files directly under the folder", () => {
    const root = buildFileTree([md("projects/a.md"), md("projects/b.md")]);
    expect(countFilesUnderFolder(root, "projects")).toBe(2);
  });

  it("counts files nested in subfolders, regardless of collapse state", () => {
    // countFilesUnderFolder walks the nested tree, not the flattened
    // collapse-aware row list — a collapsed subfolder must not undercount.
    const root = buildFileTree([
      md("projects/a.md"),
      md("projects/deep/b.md"),
      md("projects/deep/deeper/c.md"),
    ]);
    expect(countFilesUnderFolder(root, "projects")).toBe(3);
  });

  it("returns 0 for a folder with no files", () => {
    const root = buildFileTree([], ["empty"]);
    expect(countFilesUnderFolder(root, "empty")).toBe(0);
  });

  it("returns 0 for an unknown folder path", () => {
    const root = buildFileTree([md("welcome.md")]);
    expect(countFilesUnderFolder(root, "nope")).toBe(0);
  });

  it("doesn't count files outside the folder", () => {
    const root = buildFileTree([
      md("projects/a.md"),
      md("other/b.md"),
      md("root.md"),
    ]);
    expect(countFilesUnderFolder(root, "projects")).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/sidebar/fileTree.test.ts`
Expected: FAIL — `countFilesUnderFolder is not a function` (or a TS/import error to the same effect).

- [ ] **Step 4: Implement `countFilesUnderFolder`**

In `ui/src/sidebar/fileTree.ts`, add at the end of the file (after `buildStableTreeRows`):

```ts
function findFolder(node: FolderNode, path: string): FolderNode | null {
  if (node.path === path) return node;
  for (const child of node.folders) {
    const found = findFolder(child, path);
    if (found) return found;
  }
  return null;
}

function countFiles(node: FolderNode): number {
  return (
    node.files.length +
    node.folders.reduce((sum, child) => sum + countFiles(child), 0)
  );
}

/**
 * Number of files nested anywhere under `folderPath` — used for the
 * delete-confirmation message ("Delete 'projects' and its N files?").
 * Walks the nested tree (not the flattened, collapse-aware row list) so a
 * collapsed subfolder doesn't undercount.
 */
export function countFilesUnderFolder(root: FolderNode, folderPath: string): number {
  const folder = findFolder(root, folderPath);
  return folder ? countFiles(folder) : 0;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/sidebar/fileTree.test.ts`
Expected: all tests pass (20 tests: the 15 existing + 5 new).

Then run the full suite and typecheck to confirm no regressions:

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; all tests pass (694 tests: the 682 from before this plan + 5 `countFilesUnderFolder` tests + wait — the `deleteFile`/`DeleteFileRequest` addition has no tests, so the count is 682 + 5 = 687).

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/ipc.ts ui/src/sidebar/fileTree.ts ui/src/sidebar/fileTree.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): add deleteFile IPC wrapper and countFilesUnderFolder helper

Prep layer for the sidebar right-click delete flow: the IPC call to the
new delete_path engine command, and a pure helper to compute the
delete-confirmation dialog's file count from the in-memory tree.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — wire the context menu (create/delete flows + render)

**Files:**
- Modify: `ui/src/App.tsx` (context-menu state, folder/empty-space triggers, create/delete handlers, confirm dialog, render block)

**Interfaces:**
- Consumes: `deleteFile`, `DeleteFileRequest` (Task 2, `ipc.ts`); `countFilesUnderFolder`, `buildFileTree` (Task 2/`fileTree.ts`); `createFile`, `createFolder`, `showToast`, `errorMessage`, `refreshFileList` — all already present in `App.tsx`.
- Produces: nothing consumed by later tasks — this is the last task.

This task has no automated test coverage of its own: `App.tsx`'s interactive wiring is operator-smoke-only per this codebase's existing convention (the current Rename flow it's extending has no dedicated test either). Verification is `tsc` + the full `vitest` regression suite + `vite build`, plus a manual smoke pass in the running app at the end.

- [ ] **Step 1: Update imports**

In `ui/src/App.tsx`, change the `fileTree` import:

```ts
import {
  buildFileTree,
  buildStableTreeRows,
  countFilesUnderFolder,
  type FlatRow,
} from "./sidebar/fileTree";
```

Add `deleteFile` to the `ipc` import block (alphabetically, near `createFolder`):

```ts
import {
  createBlockRef,
  createFile,
  createFileAtPath,
  createFolder,
  deleteFile,
  getBrokenBlockRefs,
  getSetting,
  listFiles,
  listTags,
  onVaultFileChanged,
  onVaultFlushComplete,
  onVaultPendingRewritesChanged,
  onVaultScanCancelled,
  onVaultScanComplete,
  onVaultScanProgress,
  openVault,
  readFileText,
  renameFile,
  writeFileText,
  type BrokenBlockRef,
  type FileEntry,
  type ResolvedAnchor,
} from "./api/ipc";
```

(Keep every other name in that block unchanged — only `deleteFile` is new.)

- [ ] **Step 2: Add the shared context-menu item style + widen `contextMenu`'s type**

Near the top of `App.tsx`, alongside the other module-level constants (e.g. next to `const AUTOSAVE_DEBOUNCE_MS = 300;`), add:

```ts
const contextMenuItemStyle: JSX.CSSProperties = {
  display: "block",
  width: "100%",
  "text-align": "left",
  padding: "var(--space-2) var(--space-3)",
  background: "transparent",
  border: "none",
  color: "var(--c-fg-primary)",
  "font-family": "var(--font-body)",
  "font-size": "var(--text-sm)",
  cursor: "pointer",
};
```

Change the `contextMenu` signal (currently):

```ts
  const [contextMenu, setContextMenu] = createSignal<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
```

to:

```ts
  const [contextMenu, setContextMenu] = createSignal<{
    kind: "file" | "folder" | "empty";
    /** Right-clicked row's path; `""` for `kind === "empty"`. */
    path: string;
    x: number;
    y: number;
  } | null>(null);
```

Immediately after it, add the delete-confirm state:

```ts
  const [deleteTarget, setDeleteTarget] = createSignal<{
    path: string;
    kind: "file" | "folder";
    fileCount: number;
  } | null>(null);
  const [deleteInFlight, setDeleteInFlight] = createSignal(false);
```

- [ ] **Step 3: Add the create/delete handlers**

Immediately after the existing `handleNewFolder` function (after its closing `}`, before `onMount(async () => {`), add:

```ts
  /**
   * Context-menu "New File" — scoped to `parentDir` (a right-clicked
   * folder's path, or `""` for empty-space/root). Unlike the toolbar's
   * `handleNewFile`, this doesn't navigate to the new file — it enters
   * inline rename mode so the user names it in one motion.
   */
  const handleContextMenuNewFile = async (parentDir: string) => {
    const id = vaultId();
    if (!id) return;
    try {
      const resp = await createFile({ vault_id: id, parent_dir: parentDir });
      await refreshFileList();
      setRenamingPath(resp.path);
    } catch (e) {
      showToast(errorMessage(e));
    }
  };

  /**
   * Context-menu "New Folder" — scoped to `parentDir`. Folders can't be
   * renamed yet (no backend support — spec's "Folder rename is out of
   * scope"), so this just creates it and lets the tree refresh show it,
   * matching the toolbar button's existing behavior.
   */
  const handleContextMenuNewFolder = async (parentDir: string) => {
    const id = vaultId();
    if (!id) return;
    try {
      await createFolder({ vault_id: id, parent_dir: parentDir });
      await refreshFileList();
    } catch (e) {
      showToast(errorMessage(e));
    }
  };

  /** Open the delete-confirm dialog for a right-clicked row. */
  const handleRequestDelete = (path: string, kind: "file" | "folder") => {
    const fileCount =
      kind === "folder"
        ? countFilesUnderFolder(buildFileTree(files(), folders()), path)
        : 0;
    setDeleteTarget({ path, kind, fileCount });
  };

  /** Confirm-dialog "Delete" — moves the target to the OS trash. */
  const handleConfirmDelete = async () => {
    const id = vaultId();
    const target = deleteTarget();
    if (!id || !target) return;
    setDeleteInFlight(true);
    try {
      await deleteFile({ vault_id: id, path: target.path });
      setDeleteTarget(null);
    } catch (e) {
      showToast(errorMessage(e));
    } finally {
      setDeleteInFlight(false);
    }
  };
```

- [ ] **Step 4: Reset delete state on vault close**

In the vault-close reset block (the one containing `setContextMenu(null);` and `setRenamingPath(null);`), add `setDeleteTarget(null);` immediately after `setContextMenu(null);`:

```ts
      setContextMenu(null);
      setDeleteTarget(null);
      setRenamingPath(null);
```

- [ ] **Step 5: Add `onContextMenu` to the file row (tag its kind, stop propagation)**

The file row currently has:

```tsx
                            onContextMenu={(e) => {
                              if (!isMarkdown) return;
                              e.preventDefault();
                              setContextMenu({
                                path: row.path,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
```

Change to:

```tsx
                            onContextMenu={(e) => {
                              if (!isMarkdown) return;
                              e.preventDefault();
                              e.stopPropagation();
                              setContextMenu({
                                kind: "file",
                                path: row.path,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
```

(`stopPropagation` matters now: without it, a right-click on a row would bubble to the new empty-space handler on the listbox container added in Step 7 and overwrite the menu with `kind: "empty"`.)

- [ ] **Step 6: Add `onContextMenu` to the folder row**

The folder row currently has:

```tsx
                        if (row.kind === "folder") {
                          return (
                            <div
                              class="tree-row tree-row--folder"
                              role="treeitem"
                              aria-expanded={!row.collapsed}
                              style={{
                                height: `${FILE_ROW_HEIGHT}px`,
                                "padding-left": folderPad,
                              }}
                              onClick={() => toggleFolder(row.path)}
                            >
```

Add an `onContextMenu` prop:

```tsx
                        if (row.kind === "folder") {
                          return (
                            <div
                              class="tree-row tree-row--folder"
                              role="treeitem"
                              aria-expanded={!row.collapsed}
                              style={{
                                height: `${FILE_ROW_HEIGHT}px`,
                                "padding-left": folderPad,
                              }}
                              onClick={() => toggleFolder(row.path)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                  kind: "folder",
                                  path: row.path,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                            >
```

- [ ] **Step 7: Add `onContextMenu` for empty space**

The sidebar's scrollable listbox container currently has:

```tsx
              <div
              role="listbox"
              aria-label="Vault files"
              ref={(el) => setViewportHeight(el.clientHeight || 600)}
              onScroll={(e) => {
                setScrollTop(e.currentTarget.scrollTop);
                setViewportHeight(e.currentTarget.clientHeight);
              }}
              style={{
                "overflow-y": "auto",
                position: "relative",
                flex: 1,
                "min-height": 0,
                "min-width": 0,
              }}
            >
```

Add an `onContextMenu` prop (fires only for a genuine empty-space right-click, since row-level handlers now call `stopPropagation`):

```tsx
              <div
              role="listbox"
              aria-label="Vault files"
              ref={(el) => setViewportHeight(el.clientHeight || 600)}
              onScroll={(e) => {
                setScrollTop(e.currentTarget.scrollTop);
                setViewportHeight(e.currentTarget.clientHeight);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ kind: "empty", path: "", x: e.clientX, y: e.clientY });
              }}
              style={{
                "overflow-y": "auto",
                position: "relative",
                flex: 1,
                "min-height": 0,
                "min-width": 0,
              }}
            >
```

- [ ] **Step 8: Rewrite the context-menu render block**

Replace the entire existing block (from `<Show when={contextMenu()}>` through its matching `</Show>`, currently ending right before `<ToastHost />`):

```tsx
      <Show when={contextMenu()}>
        {(menu) => (
          <>
            <div
              onClick={() => setContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu(null);
              }}
              style={{
                position: "fixed",
                inset: 0,
                "z-index": 12,
                background: "transparent",
              }}
            />
            <div
              role="menu"
              style={{
                position: "fixed",
                top: `${menu().y}px`,
                left: `${menu().x}px`,
                "min-width": "10rem",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-md)",
                "box-shadow": "var(--shadow-md)",
                padding: "var(--space-1) 0",
                "z-index": 13,
              }}
            >
              <Show when={menu().kind !== "file"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const parentDir = menu().path;
                    setContextMenu(null);
                    void handleContextMenuNewFile(parentDir);
                  }}
                  style={contextMenuItemStyle}
                >
                  New File
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const parentDir = menu().path;
                    setContextMenu(null);
                    void handleContextMenuNewFolder(parentDir);
                  }}
                  style={contextMenuItemStyle}
                >
                  New Folder
                </button>
              </Show>
              <Show when={menu().kind === "file"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const path = menu().path;
                    setContextMenu(null);
                    setRenamingPath(path);
                  }}
                  style={contextMenuItemStyle}
                >
                  Rename…
                </button>
              </Show>
              <Show when={menu().kind !== "empty"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const path = menu().path;
                    const kind = menu().kind === "folder" ? "folder" : "file";
                    setContextMenu(null);
                    handleRequestDelete(path, kind);
                  }}
                  style={{ ...contextMenuItemStyle, color: "var(--c-error)" }}
                >
                  Delete…
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>

      <Show when={deleteTarget()}>
        {(target) => (
          <div
            class="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm delete"
            style={{ "z-index": 30 }}
            onClick={() => !deleteInFlight() && setDeleteTarget(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(24rem, 90vw)",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-lg, var(--radius-md))",
                "box-shadow": "var(--shadow-lg, var(--shadow-md))",
                padding: "var(--space-4)",
                display: "flex",
                "flex-direction": "column",
                gap: "var(--space-3)",
              }}
            >
              <p
                style={{
                  margin: 0,
                  "font-size": "var(--text-sm)",
                  color: "var(--c-fg-primary)",
                }}
              >
                {target().kind === "folder"
                  ? `Delete "${target().path}" and its ${target().fileCount} file${
                      target().fileCount === 1 ? "" : "s"
                    }?`
                  : `Delete "${target().path}"?`}
              </p>
              <div
                style={{
                  display: "flex",
                  "justify-content": "flex-end",
                  gap: "var(--space-2)",
                }}
              >
                <button
                  type="button"
                  disabled={deleteInFlight()}
                  onClick={() => setDeleteTarget(null)}
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    background: "transparent",
                    border: "1px solid var(--c-border-subtle)",
                    "border-radius": "var(--radius-md)",
                    color: "var(--c-fg-primary)",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-sm)",
                    cursor: deleteInFlight() ? "default" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleteInFlight()}
                  onClick={() => void handleConfirmDelete()}
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    background: "var(--c-error)",
                    border: "none",
                    "border-radius": "var(--radius-md)",
                    color: "white",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-sm)",
                    cursor: deleteInFlight() ? "default" : "pointer",
                  }}
                >
                  {deleteInFlight() ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <ToastHost />
```

- [ ] **Step 9: Typecheck, run the full test suite, and build**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

Run: `cd ui && npx vitest run`
Expected: all tests pass, same count as after Task 2 (687) — this task adds no new automated tests.

Run: `cd ui && npm run build`
Expected: builds cleanly (the existing "chunks larger than 500kB" warning is pre-existing and unrelated).

- [ ] **Step 10: Manual smoke pass**

Run `cargo tauri dev` (or use whatever preview mechanism is available in your environment) against a test vault, and walk through:

1. Right-click a folder row → menu shows New File, New Folder, Delete (no Rename). Click New File → a new `Untitled.md` (or suffixed) appears inside that folder, immediately in rename mode → type a name → Enter → row shows the new name.
2. Right-click the same folder → New Folder → a new `Untitled Folder` appears inside it, not in rename mode.
3. Right-click empty space below the last row → menu shows New File, New Folder only. Click New File → new file appears at vault root, in rename mode.
4. Right-click a file row → menu shows Rename…, Delete… (unchanged Rename behavior). Click Delete… → confirm dialog reads `Delete "path/to/file.md"?` → Cancel dismisses with no change → Delete… again → confirm → row disappears from the tree, file lands in the OS trash.
5. Right-click a folder containing files → Delete… → dialog reads `Delete "folder" and its N files?` with the correct count (including files in nested subfolders) → confirm → folder and all contents disappear from the tree, land in the OS trash as one unit.
6. Escape and backdrop-click both dismiss the context menu and the confirm dialog without side effects.

- [ ] **Step 11: Commit**

```bash
git add ui/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): sidebar right-click create/delete for files and folders

Right-click a folder or empty sidebar space to create a file/folder
inside it (new files auto-enter rename mode); right-click any row to
delete it, with a confirm dialog, to the OS trash. Folder rename stays
out of scope (no backend support yet).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

After all three tasks:

Run: `./scripts/check.sh`
Expected: `All gates green.` (tsc, vitest, ui build, cargo fmt, cargo clippy, cargo test, docs — the same gate set CI runs on every PR).
