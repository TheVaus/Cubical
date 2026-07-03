# Folder Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click a folder row → Rename… → inline-edit its name, moving every nested file and subfolder with it, with the same referrer-link durability guarantees single-file rename already has.

**Architecture:** Extract `rename_file`'s per-file FK-rekey logic into three shared functions (referrer collection, in-transaction rekey, in-transaction referrer enqueue). `rename_file` calls them once, behaviorally unchanged. A new `rename_folder` command calls them once per file under the old prefix, inside one transaction covering the whole subtree, then moves the directory on disk as a single atomic operation.

**Tech Stack:** Rust (`cubical-engine`), Solid.js/TypeScript (`ui/src/App.tsx`, `ui/src/fileRename.ts`, `ui/src/api/ipc.ts`).

## Global Constraints

- `rename_file`'s existing behavior must be provably unchanged after the extraction — verified by its existing 9-test suite (no new tests needed for that half).
- Folder rename is *rename in place* only (same parent, new name) — a target name containing `/` is rejected as invalid, never treated as a move.
- Folder names skip the dot restriction (`isValidNoteName`) that file names have — that rule exists for `[[note.prop]]` property-ref collisions, which don't apply to folders.
- Referrer text rewrites stay on the existing deferred `pending_rewrites` queue — no new flush/timing logic.
- One shared `rename_op_id` covers the whole folder-rename operation (not one per file) — it shows as a single entry in the recent-renames list, consistent with "one user action, one op".
- Cross-filesystem folder moves (EXDEV) are out of scope — return an error rather than implementing a recursive copy-then-remove fallback. `rename_file` already accepts this same class of risk for the single-file case; a whole-vault directory tree living on one filesystem is the overwhelmingly common case.
- Spec: `docs/superpowers/specs/2026-07-03-folder-rename-design.md`.

---

### Task 1: Extract shared per-file rename primitives (regression-safe refactor)

**Files:**
- Modify: `crates/cubical-engine/src/commands/rename.rs`

**Interfaces:**
- Produces: three new private functions in `rename.rs` — `collect_referrers`, `rekey_file_in_tx`, `enqueue_referrers_in_tx` (exact signatures below). Task 2 calls all three; `rename_file` (refactored in this task) calls all three too.

This task moves existing, already-correct code into reusable functions — it does not change behavior. The regression net is `rename_file`'s own existing test suite (9 tests, lines 1453–2296 in the current file), which must all still pass unchanged.

- [ ] **Step 1: Add the three shared functions**

Insert immediately after `read_bool_setting` (after its closing `}`, before the `// -- Rename IPC handlers --` comment that precedes `rename_file`):

```rust
/// Phase A of a rename: collect a file's referrers (files whose wiki-links
/// resolve to it, plus — when `rewrite_broken` — files whose broken links
/// name it by basename or path form) without writing anything. Read-only,
/// so it's safe to call for every file in a batch before any of them are
/// rewritten — every call sees the same pre-rename snapshot.
///
/// Mirrors `rename_file`'s original pre-transaction referrer resolution
/// exactly, so a single-file call produces referrer data byte-identical
/// to what `rename_file` computed before this extraction.
async fn collect_referrers(
    conn: &libsql::Connection,
    from_path: &str,
    rewrite_broken: bool,
) -> Result<Vec<(String, String)>, CubicalError> {
    let mut referrers: Vec<(String, String)> = {
        let mut rows = conn
            .query(
                "SELECT DISTINCT source_path, target_raw FROM links WHERE target_path = ?1",
                params![from_path.to_string()],
            )
            .await?;
        let mut out: Vec<(String, String)> = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push((row.get(0)?, row.get(1)?));
        }
        out
    };
    if rewrite_broken {
        let (old_basename, old_path_no_md) = link_name_forms(from_path);
        referrers
            .extend(select_broken_referrers_naming(conn, &old_basename, &old_path_no_md).await?);
    }
    Ok(referrers)
}

/// Phase B of a rename: explicit FK rekey + `files.path` update for one
/// file, inside the caller's transaction. No FK on these tables has `ON
/// UPDATE CASCADE`, so children must be rekeyed before the parent
/// `files.path` update (the transaction must already have
/// `PRAGMA defer_foreign_keys = 1` set, so the intermediate
/// children-point-at-new-path-while-files.path-still-old state doesn't
/// trip `ON UPDATE NO ACTION`).
///
/// Mirrors `rename_file`'s original in-transaction rekey block exactly.
async fn rekey_file_in_tx(
    tx: &libsql::Transaction,
    from_path: &str,
    to_path: &str,
    rewrite_broken: bool,
) -> Result<(), CubicalError> {
    for (table, column) in [
        ("links", "source_path"),
        ("tags", "file_path"),
        ("blocks", "file_path"),
        ("block_refs", "source_file_path"),
        ("frontmatter", "file_path"),
    ] {
        let sql = format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2");
        tx.execute(&sql, params![to_path.to_string(), from_path.to_string()])
            .await?;
    }
    tx.execute(
        "UPDATE block_refs SET target_file_path = ?1 WHERE target_file_path = ?2",
        params![to_path.to_string(), from_path.to_string()],
    )
    .await?;
    tx.execute(
        "UPDATE links SET target_path = ?1 WHERE target_path = ?2",
        params![to_path.to_string(), from_path.to_string()],
    )
    .await?;
    if rewrite_broken {
        let (old_basename, old_path_no_md) = link_name_forms(from_path);
        reconnect_broken_links_to(tx, to_path, &old_basename, &old_path_no_md).await?;
    }
    tx.execute(
        "UPDATE files SET path = ?1 WHERE path = ?2",
        params![to_path.to_string(), from_path.to_string()],
    )
    .await?;
    Ok(())
}

/// Phase C of a rename: enqueue one pending rewrite per referrer, inside
/// the caller's transaction. Returns the (possibly-remapped) target_file
/// of each row touched, for the caller's 50-per-file fuse check.
///
/// `referrers` is used exactly as given — the caller is responsible for
/// resolving any referrer that is itself being renamed in the same
/// operation to its final path before calling this (see `rename_folder`
/// in Task 2). For `rename_file`'s single-file call, `referrers` is
/// passed through unresolved, matching its original behavior exactly
/// (including the pre-existing edge case where a file linking to itself
/// enqueues against its own old path — not something this refactor
/// changes).
async fn enqueue_referrers_in_tx(
    tx: &libsql::Transaction,
    from_path: &str,
    to_path: &str,
    referrers: &[(String, String)],
    now: i64,
    rename_op_id: i64,
) -> Result<Vec<String>, CubicalError> {
    let mut touched = Vec::with_capacity(referrers.len());
    for (source_path, target_raw) in referrers {
        let new_token = derive_wikilink_new_token(target_raw, from_path, to_path);
        enqueue_coalesced(
            tx,
            source_path,
            "wiki_link",
            target_raw,
            &new_token,
            now,
            rename_op_id,
        )
        .await?;
        touched.push(source_path.clone());
    }
    Ok(touched)
}
```

- [ ] **Step 2: Refactor `rename_file` to call the three shared functions**

Replace the body of `rename_file` (currently lines 301–545-ish, from `pub async fn rename_file(` through its closing `}`) with:

```rust
pub async fn rename_file(
    state: &AppState,
    app: &dyn EventSink,
    req: RenameFileRequest,
) -> Result<RenameFileResponse, CubicalError> {
    if req.from_path == req.to_path {
        return Err(CubicalError::InvalidRequest("from_path == to_path".into()));
    }
    let (vault, flush_own_writes, _flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let conn = vault.index().connection();

    let from_abs = vault.root().join(&req.from_path);
    let to_abs = vault.root().join(&req.to_path);
    if to_abs.exists() {
        return Err(CubicalError::InvalidRequest(format!(
            "destination path already exists: {}",
            req.to_path
        )));
    }
    if !path_tracked(conn, &req.from_path).await? {
        return Err(CubicalError::FileNotFound(req.from_path.clone()));
    }

    let rewrite_broken =
        read_bool_setting(state, &req.vault_id, WIKILINKS_REWRITE_BROKEN_KEY, true).await;
    let referrers = collect_referrers(conn, &req.from_path, rewrite_broken).await?;

    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    tx.execute("PRAGMA defer_foreign_keys = 1", ()).await?;
    let fuse_targets = enqueue_referrers_in_tx(
        &tx,
        &req.from_path,
        &req.to_path,
        &referrers,
        now,
        rename_op_id,
    )
    .await?;
    rekey_file_in_tx(&tx, &req.from_path, &req.to_path, rewrite_broken).await?;
    tx.commit().await?;

    // Move the file on disk. `fs::rename` is the same-FS fast path; the
    // cross-FS fallback copy-then-remove uses atomic_write to keep
    // observers from seeing a half-written destination. Failures here
    // leave a divergence (`files.path` = to_path, disk still at
    // from_path) that the next watcher tick will surface; surface as
    // Io for the caller to retry.
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CubicalError::Io(e.to_string()))?;
    }
    if let Err(e) = std::fs::rename(&from_abs, &to_abs) {
        if e.raw_os_error() == Some(18) {
            let bytes = std::fs::read(&from_abs).map_err(|e| CubicalError::Io(e.to_string()))?;
            atomic_write(&to_abs, &bytes).map_err(|e| CubicalError::Io(e.to_string()))?;
            std::fs::remove_file(&from_abs).map_err(|e| CubicalError::Io(e.to_string()))?;
        } else {
            return Err(CubicalError::Io(e.to_string()));
        }
    }

    // Durably journal the rename so an index wipe before flush can't
    // strand referrer links (design 2026-06-27).
    if let Err(e) = cubical_core::vault::rename_journal::append_entry(
        vault.root(),
        &cubical_core::vault::rename_journal::RenameJournalEntry {
            op_id: rename_op_id,
            kind: "file".into(),
            from: req.from_path.clone(),
            to: req.to_path.clone(),
            at: now,
        },
    ) {
        tracing::warn!(error = %e, "rename: failed to write durability journal");
    }

    // Re-extract the moved file's outbound rows under the new path.
    let on_disk = tokio::task::spawn_blocking({
        let to_abs = to_abs.clone();
        move || std::fs::read_to_string(&to_abs)
    })
    .await
    .map_err(|e| CubicalError::Io(format!("re-extract read join error: {e}")))?
    .map_err(|e| CubicalError::Io(e.to_string()))?;
    let _ = refresh_frontmatter(&vault, &req.to_path, &on_disk).await;
    let _ = refresh_links(&vault, &req.to_path, &on_disk).await;
    let _ = refresh_tags(&vault, &req.to_path, &on_disk).await;
    let _ = refresh_blocks(&vault, &req.to_path, &on_disk).await;
    let _ = refresh_block_refs_for_file(&vault, &req.to_path).await;

    // L4-B: keep the Tantivy search index in sync here rather than
    // relying on the watcher (which lags / may coalesce app-initiated
    // renames, leaving the old path's doc searchable).
    let _ = delete_search_index(&vault, &req.from_path).await;
    let (mtime_secs, size_bytes) = std::fs::metadata(&to_abs)
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
                .unwrap_or(0);
            (mtime, m.len())
        })
        .unwrap_or((0, on_disk.len() as u64));
    let _ = refresh_search_index(&vault, &req.to_path, &on_disk, mtime_secs, size_bytes).await;
    let _ = vault.search().commit();

    // >50-per-file fuse — spec §5.7.
    enforce_fifty_per_file_fuse(&vault, &flush_own_writes, &fuse_targets).await?;

    let pending_count = pending_count_total(vault.index()).await?;
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(RenameFileResponse {
        rename_op_id,
        pending_count,
    })
}
```

Note what changed vs. the original: the referrer SELECT now goes through `collect_referrers` (using `conn`, same as before — happens before the transaction opens, identical timing to the original); the enqueue loop is now `enqueue_referrers_in_tx` (called BEFORE `rekey_file_in_tx` in this refactored version, whereas the original enqueued and rekeyed in the same loop pass — this ordering swap is safe and behavior-preserving because enqueueing reads/writes only `pending_rewrites` while rekeying touches `links`/`tags`/`blocks`/`block_refs`/`frontmatter`/`files` — disjoint tables, so which happens first within the same transaction doesn't change the net result); the FK rekey + `files.path` update is now `rekey_file_in_tx`. Everything else (disk move, journal, re-extraction, search sync, fuse, event emission) is untouched, copied verbatim from the original function body.

- [ ] **Step 3: Run `rename_file`'s existing test suite to verify no regression**

Run: `cargo test -p cubical-engine rename_file`
Expected: all 9 existing tests pass (`rename_file_enqueues_one_row_per_distinct_referrer_pair`, `rename_file_round_trip_cancels_pending_rows`, `rename_file_chained_coalesces_into_single_row`, `rename_file_keeps_search_index_in_sync`, `rename_file_appends_durability_journal`, `rename_file_explicit_rekeys_fk_tables_to_new_path`, `rename_file_moves_the_file_on_disk`, `rename_file_rejects_same_path_and_existing_destination`, `rename_file_links_target_path_rekeys_too`).

If any fail, the refactor introduced a behavior change — do not proceed to Task 2 until every one of these passes exactly as it did before this task.

- [ ] **Step 4: Run the full engine test suite**

Run: `cargo test -p cubical-engine`
Expected: all tests pass (no regressions elsewhere — `rename_tag`/`rename_block_id`/flush tests etc. don't touch the refactored code path, but confirm anyway).

- [ ] **Step 5: fmt + clippy**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`
Expected: no diff from fmt, no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-engine/src/commands/rename.rs
git commit -m "$(cat <<'EOF'
refactor(engine): extract rename_file's per-file rekey into shared fns

collect_referrers / rekey_file_in_tx / enqueue_referrers_in_tx pull the
existing referrer-resolution, FK-rekey, and pending-rewrite-enqueue
logic out of rename_file so a future rename_folder can reuse it across
a subtree. Behavior-preserving: rename_file's existing 9-test suite
passes unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `rename_folder` command + types + Tauri wiring + Rust tests

**Files:**
- Modify: `crates/cubical-engine/src/api/types.rs` (add `RenameFolderRequest`/`RenameFolderResponse`)
- Modify: `crates/cubical-engine/src/commands/rename.rs` (add `rename_folder`, tests)
- Modify: `crates/cubical-app/src/lib.rs` (register the Tauri shim)

**Interfaces:**
- Consumes: `collect_referrers(conn, from_path, rewrite_broken) -> Result<Vec<(String,String)>, CubicalError>`, `rekey_file_in_tx(tx, from_path, to_path, rewrite_broken) -> Result<(), CubicalError>`, `enqueue_referrers_in_tx(tx, from_path, to_path, referrers, now, rename_op_id) -> Result<Vec<String>, CubicalError>` — all from Task 1.
- Produces: `pub async fn rename_folder(state: &AppState, app: &dyn EventSink, req: RenameFolderRequest) -> Result<RenameFolderResponse, CubicalError>`. Task 3's frontend `renameFolder` IPC wrapper calls this via the Tauri shim.

- [ ] **Step 1: Add `RenameFolderRequest`/`RenameFolderResponse`**

In `crates/cubical-engine/src/api/types.rs`, insert immediately after the `RenameFileResponse` struct (after its closing `}`, before the `/// Request payload for \`rename_tag\`.` doc comment):

```rust
/// Request payload for `rename_folder`.
#[derive(Debug, Clone, Deserialize)]
pub struct RenameFolderRequest {
    /// Vault hosting the folder being renamed.
    pub vault_id: String,
    /// Current vault-relative folder path (must be tracked in `folders`).
    pub from_path: String,
    /// Target vault-relative folder path (must not already exist).
    pub to_path: String,
}

/// Response payload for `rename_folder`.
#[derive(Debug, Clone, Serialize)]
pub struct RenameFolderResponse {
    /// The rename_op_id shared by every file moved in this operation.
    pub rename_op_id: i64,
    /// New total pending-rewrites count for the vault, post-enqueue.
    pub pending_count: i64,
}
```

- [ ] **Step 2: Write the failing tests**

In `crates/cubical-engine/src/commands/rename.rs`, inside `mod tests`:

This file's test module already has everything needed to seed a vault —
reuse it exactly, don't add parallel helpers: `fresh(vault_id: &str) ->
(TempDir, Vault, AppState)` opens a temp vault and registers it in
`AppState`; `seed_file(vault, rel, type_id)` inserts a `files` row (you
still need `std::fs::write` separately for any file whose bytes actually
need to exist on disk); `replace_links_for_file(vault.index(), source,
&[LinkRow { .. }])` seeds link rows directly, no markdown parsing needed;
`NoopEventSink` (imported via `use crate::events::NoopEventSink;` a few
lines above the existing `rename_file` tests) is the test event sink —
reuse that import, don't add a second one.

Add one more tiny seed helper (folders aren't covered by `seed_file`) and
five tests, after the existing `rename_file_links_target_path_rekeys_too`
test (after its closing `}`):

```rust
    async fn seed_folder(vault: &Vault, rel: &str) {
        cubical_index::upsert_folder(vault.index(), rel, 0)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rename_folder_moves_nested_files_and_subfolder() {
        let (dir, vault, state) = fresh("v1").await;
        seed_folder(&vault, "projects").await;
        seed_folder(&vault, "projects/deep").await;
        seed_file(&vault, "projects/a.md", "markdown").await;
        seed_file(&vault, "projects/deep/b.md", "markdown").await;
        std::fs::create_dir_all(dir.path().join("projects/deep")).unwrap();
        std::fs::write(dir.path().join("projects/a.md"), "a body\n").unwrap();
        std::fs::write(dir.path().join("projects/deep/b.md"), "b body\n").unwrap();

        rename_folder(
            &state,
            &NoopEventSink,
            RenameFolderRequest {
                vault_id: "v1".into(),
                from_path: "projects".into(),
                to_path: "work".into(),
            },
        )
        .await
        .expect("rename folder");

        assert!(!dir.path().join("projects").exists());
        assert!(dir.path().join("work/a.md").exists());
        assert!(dir.path().join("work/deep/b.md").exists());

        let folders = cubical_index::list_folders(vault.index()).await.unwrap();
        assert!(folders.contains(&"work".to_string()));
        assert!(folders.contains(&"work/deep".to_string()));
        assert!(!folders.contains(&"projects".to_string()));
        assert!(!folders.contains(&"projects/deep".to_string()));

        let mut rows = vault
            .index()
            .connection()
            .query("SELECT path FROM files ORDER BY path", ())
            .await
            .unwrap();
        let mut paths = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            paths.push(row.get::<String>(0).unwrap());
        }
        assert_eq!(
            paths,
            vec!["work/a.md".to_string(), "work/deep/b.md".to_string()]
        );
    }

    #[tokio::test]
    async fn rename_folder_resolves_intra_folder_referrer_to_its_new_path() {
        // a.md links to b.md in PATH form ([[projects/b]], not the bare
        // basename [[b]] — a same-basename link needs no text rewrite at
        // all when only the containing folder moves, so it wouldn't
        // exercise this path). After the rename, the pending rewrite
        // queued against a's link must target a's NEW path ("work/a.md"),
        // not "projects/a.md" — which is about to disappear — and its
        // new_token must reflect b's new full path.
        let (dir, vault, state) = fresh("v1").await;
        seed_folder(&vault, "projects").await;
        seed_file(&vault, "projects/a.md", "markdown").await;
        seed_file(&vault, "projects/b.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "projects/a.md",
            &[LinkRow {
                target_raw: "projects/b".into(),
                target_path: Some("projects/b.md".into()),
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 0,
            }],
        )
        .await
        .unwrap();
        std::fs::create_dir_all(dir.path().join("projects")).unwrap();
        std::fs::write(dir.path().join("projects/a.md"), "see [[projects/b]]\n").unwrap();
        std::fs::write(dir.path().join("projects/b.md"), "body\n").unwrap();

        rename_folder(
            &state,
            &NoopEventSink,
            RenameFolderRequest {
                vault_id: "v1".into(),
                from_path: "projects".into(),
                to_path: "work".into(),
            },
        )
        .await
        .expect("rename folder");

        let rows = pending_for_target(vault.index(), "work/a.md")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "the rewrite must target a's NEW path");
        assert_eq!(rows[0].old_token, "projects/b");
        assert_eq!(rows[0].new_token, "work/b");

        // And NOT queued against the old, about-to-vanish path.
        let stale = pending_for_target(vault.index(), "projects/a.md")
            .await
            .unwrap();
        assert!(stale.is_empty());
    }

    #[tokio::test]
    async fn rename_folder_rejects_destination_collision() {
        let (dir, vault, state) = fresh("v1").await;
        seed_folder(&vault, "projects").await;
        std::fs::create_dir_all(dir.path().join("projects")).unwrap();
        std::fs::create_dir_all(dir.path().join("taken")).unwrap();

        let err = rename_folder(
            &state,
            &NoopEventSink,
            RenameFolderRequest {
                vault_id: "v1".into(),
                from_path: "projects".into(),
                to_path: "taken".into(),
            },
        )
        .await
        .expect_err("must reject an existing destination");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn rename_folder_rejects_untracked_folder() {
        let (_dir, _vault, state) = fresh("v1").await;
        let err = rename_folder(
            &state,
            &NoopEventSink,
            RenameFolderRequest {
                vault_id: "v1".into(),
                from_path: "ghost".into(),
                to_path: "renamed".into(),
            },
        )
        .await
        .expect_err("must reject an untracked folder");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn rename_folder_rejects_same_path() {
        let (dir, vault, state) = fresh("v1").await;
        seed_folder(&vault, "projects").await;
        std::fs::create_dir_all(dir.path().join("projects")).unwrap();
        let err = rename_folder(
            &state,
            &NoopEventSink,
            RenameFolderRequest {
                vault_id: "v1".into(),
                from_path: "projects".into(),
                to_path: "projects".into(),
            },
        )
        .await
        .expect_err("must reject from == to");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p cubical-engine rename_folder`
Expected: compile error — `cannot find function \`rename_folder\`` and `cannot find struct \`RenameFolderRequest\``.

- [ ] **Step 4: Implement `rename_folder`**

Add `RenameFolderRequest`/`RenameFolderResponse` to the `use crate::api::types::{...}` import block in `rename.rs` (alphabetically, near the other `Rename*` types).

Add the handler after `rename_file`'s closing `}` (before `pub async fn rename_tag`):

```rust
/// `rename_folder` — rename a folder in place, moving every file and
/// subfolder nested under it. Reuses `rename_file`'s per-file primitives
/// (Task 1) across the whole subtree, inside one transaction, then moves
/// the directory on disk as a single atomic operation. One shared
/// `rename_op_id` covers every file moved.
///
/// Cross-filesystem moves (EXDEV) are not supported — same class of risk
/// `rename_file` already accepts for a single file, but a recursive
/// copy-then-remove fallback for a whole subtree is out of scope.
pub async fn rename_folder(
    state: &AppState,
    app: &dyn EventSink,
    req: RenameFolderRequest,
) -> Result<RenameFolderResponse, CubicalError> {
    if req.from_path == req.to_path {
        return Err(CubicalError::InvalidRequest("from_path == to_path".into()));
    }
    let (vault, flush_own_writes, _flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let conn = vault.index().connection();

    let from_abs = vault.root().join(&req.from_path);
    let to_abs = vault.root().join(&req.to_path);
    if to_abs.exists() {
        return Err(CubicalError::InvalidRequest(format!(
            "destination path already exists: {}",
            req.to_path
        )));
    }
    let tracked: bool = {
        let mut rows = conn
            .query(
                "SELECT 1 FROM folders WHERE path = ?1",
                params![req.from_path.clone()],
            )
            .await?;
        rows.next().await?.is_some()
    };
    if !tracked {
        return Err(CubicalError::InvalidRequest(format!(
            "folder not tracked: {}",
            req.from_path
        )));
    }

    let prefix = format!("{}/", req.from_path);
    let file_paths: Vec<String> = {
        let mut rows = conn
            .query(
                "SELECT path FROM files WHERE path = ?1 OR path LIKE ?2",
                params![req.from_path.clone(), format!("{prefix}%")],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get::<String>(0)?);
        }
        out
    };
    let folder_paths: Vec<String> = {
        let mut rows = conn
            .query(
                "SELECT path FROM folders WHERE path = ?1 OR path LIKE ?2",
                params![req.from_path.clone(), format!("{prefix}%")],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get::<String>(0)?);
        }
        out
    };

    let rewrite_broken =
        read_bool_setting(state, &req.vault_id, WIKILINKS_REWRITE_BROKEN_KEY, true).await;

    let new_path_for = |old: &str| -> String {
        if old == req.from_path {
            req.to_path.clone()
        } else {
            format!("{}{}", req.to_path, &old[req.from_path.len()..])
        }
    };
    let path_map: std::collections::HashMap<String, String> = file_paths
        .iter()
        .map(|p| (p.clone(), new_path_for(p)))
        .collect();

    // Phase A: collect every file's referrers BEFORE anything is
    // rewritten, so every lookup sees a consistent pre-rename snapshot —
    // otherwise a file processed later in the loop below could look up
    // referrers using a target_path an earlier file already rewrote.
    let mut plans: Vec<(String, String, Vec<(String, String)>)> =
        Vec::with_capacity(file_paths.len());
    for from in &file_paths {
        let referrers = collect_referrers(conn, from, rewrite_broken).await?;
        plans.push((from.clone(), path_map[from].clone(), referrers));
    }

    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    tx.execute("PRAGMA defer_foreign_keys = 1", ()).await?;

    // Phase B: rekey every file. Order-independent — each UPDATE is
    // keyed by that file's own exact old path, so no file's rekey can
    // step on another's.
    for (from, to, _) in &plans {
        rekey_file_in_tx(&tx, from, to, rewrite_broken).await?;
    }
    for old_folder in &folder_paths {
        let new_folder = new_path_for(old_folder);
        tx.execute(
            "UPDATE folders SET path = ?1 WHERE path = ?2",
            params![new_folder, old_folder.clone()],
        )
        .await?;
    }

    // Phase C: enqueue referrer rewrites, resolving any referrer that is
    // itself one of the renamed files to ITS final new path — otherwise
    // two notes in the same folder that link to each other would enqueue
    // a rewrite targeting a path that's about to disappear.
    let mut fuse_targets: Vec<String> = Vec::new();
    for (from, to, referrers) in &plans {
        let resolved: Vec<(String, String)> = referrers
            .iter()
            .map(|(source, raw)| {
                let resolved_source = path_map.get(source).cloned().unwrap_or_else(|| source.clone());
                (resolved_source, raw.clone())
            })
            .collect();
        let touched = enqueue_referrers_in_tx(&tx, from, to, &resolved, now, rename_op_id).await?;
        fuse_targets.extend(touched);
    }

    tx.commit().await?;

    // Move the whole directory on disk in one atomic operation.
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CubicalError::Io(e.to_string()))?;
    }
    if let Err(e) = std::fs::rename(&from_abs, &to_abs) {
        if e.raw_os_error() == Some(18) {
            return Err(CubicalError::Io(
                "cross-filesystem folder rename is not supported".into(),
            ));
        }
        return Err(CubicalError::Io(e.to_string()));
    }

    // Per-file: journal, re-extract outbound rows, sync search index.
    for (from, to, _) in &plans {
        if let Err(e) = cubical_core::vault::rename_journal::append_entry(
            vault.root(),
            &cubical_core::vault::rename_journal::RenameJournalEntry {
                op_id: rename_op_id,
                kind: "file".into(),
                from: from.clone(),
                to: to.clone(),
                at: now,
            },
        ) {
            tracing::warn!(error = %e, "rename_folder: failed to write durability journal");
        }

        let to_abs_file = vault.root().join(to);
        let on_disk = match tokio::task::spawn_blocking({
            let p = to_abs_file.clone();
            move || std::fs::read_to_string(&p)
        })
        .await
        {
            Ok(Ok(content)) => content,
            _ => continue,
        };
        let _ = refresh_frontmatter(&vault, to, &on_disk).await;
        let _ = refresh_links(&vault, to, &on_disk).await;
        let _ = refresh_tags(&vault, to, &on_disk).await;
        let _ = refresh_blocks(&vault, to, &on_disk).await;
        let _ = refresh_block_refs_for_file(&vault, to).await;

        let _ = delete_search_index(&vault, from).await;
        let (mtime_secs, size_bytes) = std::fs::metadata(&to_abs_file)
            .map(|m| {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
                    .unwrap_or(0);
                (mtime, m.len())
            })
            .unwrap_or((0, on_disk.len() as u64));
        let _ = refresh_search_index(&vault, to, &on_disk, mtime_secs, size_bytes).await;
    }
    let _ = vault.search().commit();

    enforce_fifty_per_file_fuse(&vault, &flush_own_writes, &fuse_targets).await?;

    let pending_count = pending_count_total(vault.index()).await?;
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(RenameFolderResponse {
        rename_op_id,
        pending_count,
    })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-engine rename_folder`
Expected: all 5 new tests pass.

If `crate::events::NoopEventSink` (or whatever the actual existing test sink is named) doesn't compile, search `rename.rs`'s own test module for how `rename_tag`/`rename_block_id` tests call their event-sink-taking functions and copy that exact pattern — do not add a new sink type.

Then run: `cargo test -p cubical-engine`
Expected: all tests pass (rename_file's 9 tests still green, plus these 5 new ones).

- [ ] **Step 6: Register the Tauri shim**

In `crates/cubical-app/src/lib.rs`, add `RenameFolderRequest, RenameFolderResponse` to the `use cubical_engine::api::types::{...}` import block (alphabetically, near `RenameFileRequest, RenameFileResponse`).

Add `rename_folder,` to the `generate_handler!` list, immediately after `rename_file,`.

Add the shim function immediately after the `rename_file` shim (after its closing `}`):

```rust
/// Tauri shim — see [`commands::rename::rename_folder`].
#[tauri::command]
async fn rename_folder(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameFolderRequest,
) -> Result<RenameFolderResponse, CubicalError> {
    commands::rename::rename_folder(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}
```

- [ ] **Step 7: Verify the whole workspace builds and tests pass**

Run: `cargo check --workspace && cargo test --workspace`
Expected: no errors, all tests pass.

- [ ] **Step 8: fmt + clippy**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`
Expected: no diff from fmt, no warnings.

- [ ] **Step 9: Commit**

```bash
git add crates/cubical-engine/src/api/types.rs crates/cubical-engine/src/commands/rename.rs crates/cubical-app/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(engine): add rename_folder — move a folder and everything under it

Reuses rename_file's per-file rekey primitives across the whole
subtree inside one transaction, then moves the directory on disk as a
single atomic operation. One shared rename_op_id covers every file
moved. Intra-folder referrers (two notes in the same folder linking to
each other) resolve to their final new path, not the one that's about
to disappear.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — `renameFolder` IPC wrapper + pure helpers

**Files:**
- Modify: `ui/src/api/ipc.ts` (add `RenameFolderRequest`/`RenameFolderResponse` + `renameFolder` wrapper)
- Modify: `ui/src/fileRename.ts` (widen `validateRenameTarget`, add `reprefixNestedPath`)
- Modify: `ui/src/fileRename.test.ts` (tests for both)

**Interfaces:**
- Produces: `renameFolder(req: RenameFolderRequest): Promise<RenameFolderResponse>` from `ipc.ts`; `validateRenameTarget(fromPath: string, rawTarget: string, isFolder?: boolean): RenameValidationError | null` (widened, existing 2-arg call sites unaffected); `reprefixNestedPath(path: string, folderPath: string, newFolderPath: string): string | null` from `fileRename.ts`. Task 4 imports all three.

- [ ] **Step 1: Add the `renameFolder` IPC wrapper**

In `ui/src/api/ipc.ts`, add the types immediately after `RenameFileResponse` (after its closing `}`, before the `RenameTagRequest` interface):

```ts
export interface RenameFolderRequest {
  vault_id: string;
  from_path: string;
  to_path: string;
}

export interface RenameFolderResponse {
  rename_op_id: number;
  pending_count: number;
}
```

Add the wrapper immediately after the `renameFile` function (after its closing `}`, before `renameTag`):

```ts
export function renameFolder(
  req: RenameFolderRequest,
): Promise<RenameFolderResponse> {
  return invoke("rename_folder", { req });
}
```

No dedicated test for this wrapper — matches the existing convention for `renameFile`/`createFile`/`deleteFile`.

- [ ] **Step 2: Write the failing tests for the pure helpers**

Read `ui/src/fileRename.test.ts` first to see its current structure, then add these tests (adjust the `describe` block placement to match what you find — if a `describe("validateRenameTarget", ...)` block already exists, add the new tests inside it; add a new `describe("reprefixNestedPath", ...)` block at the end):

```ts
  it("allows a dot in a folder name (isFolder=true skips the dot restriction)", () => {
    expect(validateRenameTarget("projects", "v1.2", true)).toBeNull();
  });

  it("still rejects a dotted file name when isFolder is false (default)", () => {
    const result = validateRenameTarget("notes/foo.md", "notes/v1.2.md");
    expect(result?.code).toBe("dotted");
  });
```

```ts
describe("reprefixNestedPath", () => {
  it("swaps the prefix for a file nested directly under the renamed folder", () => {
    expect(reprefixNestedPath("projects/a.md", "projects", "work")).toBe(
      "work/a.md",
    );
  });

  it("swaps the prefix for a file nested several levels deep", () => {
    expect(
      reprefixNestedPath("projects/deep/deeper/a.md", "projects", "work"),
    ).toBe("work/deep/deeper/a.md");
  });

  it("returns null for a file outside the renamed folder", () => {
    expect(reprefixNestedPath("other/a.md", "projects", "work")).toBeNull();
  });

  it("returns null for the folder's own path (not a nested file)", () => {
    expect(reprefixNestedPath("projects", "projects", "work")).toBeNull();
  });

  it("doesn't false-positive on a sibling folder with a shared prefix", () => {
    // "projects-archive" must not be treated as nested under "projects".
    expect(
      reprefixNestedPath("projects-archive/a.md", "projects", "work"),
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/fileRename.test.ts`
Expected: the `isFolder` test fails (dot rejected when it shouldn't be, since `validateRenameTarget` doesn't accept a third argument yet — TS will actually fail to compile this call), and `reprefixNestedPath` tests fail with `reprefixNestedPath is not a function` / import error.

- [ ] **Step 4: Implement both helpers**

In `ui/src/fileRename.ts`, replace `validateRenameTarget`'s signature and body:

```ts
export function validateRenameTarget(
  fromPath: string,
  rawTarget: string,
  isFolder = false,
): RenameValidationError | null {
  const trimmed = rawTarget.trim();
  if (trimmed === "") {
    return { code: "empty", message: "Name cannot be empty." };
  }
  if (trimmed === fromPath) {
    return { code: "same", message: "Name unchanged." };
  }
  if (!isFolder) {
    // A dotted note name isn't `[[ ]]`-linkable — the dot is the
    // property-ref separator. Folders aren't referenced via wiki-link
    // syntax, so this restriction doesn't apply to them.
    const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (!isValidNoteName(base)) {
      return { code: "dotted", message: noteNameError(base) };
    }
  }
  return null;
}
```

Add at the end of the file:

```ts
/**
 * If `path` is nested under `folderPath`, return its equivalent path
 * after the folder is renamed to `newFolderPath`; otherwise `null`.
 * Used to follow the currently-open file when the folder it lives in
 * gets renamed. A sibling folder that merely shares a name prefix
 * (`projects-archive` vs. `projects`) must not match — the check
 * requires the full `folderPath/` segment boundary.
 */
export function reprefixNestedPath(
  path: string,
  folderPath: string,
  newFolderPath: string,
): string | null {
  const prefix = `${folderPath}/`;
  if (!path.startsWith(prefix)) return null;
  return newFolderPath + path.slice(folderPath.length);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/fileRename.test.ts`
Expected: all tests pass.

Then run the full suite and typecheck:

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass (687 existing + 7 new = 694).

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/ipc.ts ui/src/fileRename.ts ui/src/fileRename.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): add renameFolder IPC wrapper and folder-rename helpers

Prep layer for folder rename: the IPC call to the new rename_folder
engine command, validateRenameTarget widened to skip the file-only dot
restriction for folders, and reprefixNestedPath for following the
currently-open file when its containing folder gets renamed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Frontend — wire folder rename into the sidebar

**Files:**
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `renameFolder` (Task 3, `ipc.ts`); `validateRenameTarget` (widened, Task 3); `reprefixNestedPath` (Task 3, `fileRename.ts`) — all newly imported in this task.

This task has no automated tests of its own — matches the existing convention for this file's interactive wiring (the file-rename flow it extends has none either). Verification is `tsc` + the full vitest regression suite + a production build, plus a manual smoke pass.

- [ ] **Step 1: Update imports**

Add `renameFolder` to the `ipc` import block in `ui/src/App.tsx` (alphabetically, near `renameFile`).

Add `reprefixNestedPath` to the `import { validateRenameTarget } from "./fileRename";` line, making it:

```ts
import { reprefixNestedPath, validateRenameTarget } from "./fileRename";
```

- [ ] **Step 2: Widen `handleRenameCommit` to handle folders**

Replace the current `handleRenameCommit` function (lines 704–753) with:

```ts
  const handleRenameCommit = async (
    fromPath: string,
    rawTarget: string,
    isFolder = false,
  ): Promise<void> => {
    const id = vaultId();
    if (!id) {
      setRenamingPath(null);
      return;
    }
    const validation = validateRenameTarget(fromPath, rawTarget, isFolder);
    if (validation !== null) {
      if (validation.code !== "same") {
        showToast(validation.message);
      }
      setRenamingPath(null);
      return;
    }
    const target = rawTarget.trim();
    setRenamingPath(null);
    try {
      if (isFolder) {
        await renameFolder({ vault_id: id, from_path: fromPath, to_path: target });
      } else {
        await renameFile({ vault_id: id, from_path: fromPath, to_path: target });
      }
      // Follow the open buffer if it was the renamed file itself, or
      // was nested under the renamed folder — without this, autosave
      // would write back to a path that no longer exists.
      if (isFolder) {
        const sel = selectedPath();
        if (sel !== null) {
          const reprefixed = reprefixNestedPath(sel, fromPath, target);
          if (reprefixed !== null) {
            setSelectedPath(reprefixed);
          }
        }
      } else if (selectedPath() === fromPath) {
        setSelectedPath(target);
      }
      // Neither rename_file nor rename_folder emits `vault:file-changed`
      // — that only arrives later (and debounced) from the watcher's
      // disk-move echo. Proactively do the same invalidation a
      // file-change does so every open view reflects the rename
      // immediately instead of resolving stale wiki-link targets /
      // showing the old name in the tree and backlinks panel.
      wikilinkResolver()?.invalidate();
      embedResolver()?.invalidate();
      propertyResolver()?.invalidate();
      dataviewRunner()?.invalidate();
      void refreshFileList();
      scheduleRightSidebarRefresh();
    } catch (e) {
      const message = errorMessage(e);
      showToast(message);
    }
  };
```

- [ ] **Step 3: Widen the context menu's Rename… item to folders**

The context menu currently has:

```tsx
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
```

Change the guard so it shows for both files and folders (still hidden for empty-space):

```tsx
              <Show when={menu().kind !== "empty"}>
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
```

- [ ] **Step 4: Add the inline rename input to the folder row**

The folder row currently is:

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
                              <span class="tree-row__twisty">
                                {row.collapsed ? "▸" : "▾"}
                              </span>
                              <span class="tree-row__name">{row.name}</span>
                            </div>
                          );
                        }
```

Replace it with:

```tsx
                        if (row.kind === "folder") {
                          const isRenamingFolder = () => renamingPath() === row.path;
                          return (
                            <div
                              class="tree-row tree-row--folder"
                              role="treeitem"
                              aria-expanded={!row.collapsed}
                              style={{
                                height: `${FILE_ROW_HEIGHT}px`,
                                "padding-left": folderPad,
                              }}
                              onClick={() => {
                                if (isRenamingFolder()) return;
                                toggleFolder(row.path);
                              }}
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
                              <span class="tree-row__twisty">
                                {row.collapsed ? "▸" : "▾"}
                              </span>
                              <Show
                                when={isRenamingFolder()}
                                fallback={
                                  <span class="tree-row__name">{row.name}</span>
                                }
                              >
                                <input
                                  type="text"
                                  class="tree-row__input"
                                  value={row.name}
                                  autofocus
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void handleRenameCommit(
                                        row.path,
                                        renameTarget(row.path, e.currentTarget.value),
                                        true,
                                      );
                                    } else if (e.key === "Escape") {
                                      e.preventDefault();
                                      setRenamingPath(null);
                                    }
                                  }}
                                  onBlur={(e) =>
                                    void handleRenameCommit(
                                      row.path,
                                      renameTarget(row.path, e.currentTarget.value),
                                      true,
                                    )
                                  }
                                />
                              </Show>
                            </div>
                          );
                        }
```

- [ ] **Step 5: Typecheck, run the full test suite, and build**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

Run: `cd ui && npx vitest run`
Expected: all tests pass, same count as after Task 3 (694) — this task adds no new automated tests.

Run: `cd ui && npm run build`
Expected: builds cleanly.

- [ ] **Step 6: Manual smoke pass**

In a running `cargo tauri dev` (or equivalent preview) against a test vault:

1. Right-click a folder containing at least one file and one nested subfolder-with-a-file → Rename… → type a new name → Enter. Confirm: the folder and everything under it disappears from its old location and reappears under the new name in the sidebar; the files' content is unchanged.
2. Repeat with one of the nested files open in the editor beforehand — confirm the editor stays on that file (doesn't show a "file not found" error) and a subsequent edit autosaves correctly (to the new location, not the old one).
3. Create two notes in the same folder that link to each other (`[[Other]]`), then rename the folder — flush pending rewrites (or wait for the periodic flush) and confirm both links still resolve to the right (renamed) targets, not broken links.
4. Attempt to rename a folder to a name that collides with an existing file or folder → confirm it's rejected with a toast, nothing moves.
5. Escape while renaming a folder → confirm it cancels with no change.

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): wire folder rename into the sidebar context menu

Folder rows get Rename… alongside New File / New Folder / Delete,
reusing the same inline F2-style input files already have. The
currently-open file follows the rename if it lived inside the renamed
folder.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

After all four tasks:

Run: `./scripts/check.sh`
Expected: `All gates green.`
