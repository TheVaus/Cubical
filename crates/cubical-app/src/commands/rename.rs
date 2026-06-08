//! L3 Session J — rename + pending-rewrites IPCs.
//!
//! All locked decisions live in
//! `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`.
//! Spec §9.15 in `docs/layer-3-spec.md` is the catalogue of what landed.
//!
//! Surface (each is a thin shim → pure handler here):
//!
//! - `rename_file` / `rename_tag` / `rename_block_id` — mint a fresh
//!   `rename_op_id`, enqueue per-distinct-target rows in
//!   `pending_rewrites`, and (for `rename_file`) atomically move the
//!   file + rekey every FK-bearing table BEFORE the `files.path` update
//!   (no FK has `ON UPDATE CASCADE`, so the rekeys are explicit).
//! - `flush_pending_rewrites` / `flush_pending_rewrites_for_target` —
//!   drain pending rows, materialize the rewrite against each target's
//!   fresh on-disk source, atomic-write the result back, and update
//!   `files.content_hash` eagerly. The own-write hash gate is populated
//!   BEFORE each write so the watcher dispatcher's Modified branch
//!   suppresses the bounce-back.
//! - `get_pending_rewrites_count` / `get_pending_rewrites_breakdown` /
//!   `list_recent_rename_ops` / `undo_rename` — thin read wrappers
//!   around the chain-1 `cubical-index::pending` query module.

use std::path::PathBuf;

use cubical_core::vault::pending::apply_pending;
use cubical_core::vault::search_refresh::{delete_search_index, refresh_search_index};
use cubical_core::{
    atomic_write, refresh_block_refs_for_file, refresh_blocks, refresh_frontmatter, refresh_links,
    refresh_tags, sha256_bytes_hex,
};
use cubical_index::{
    delete_pending_for_target, delete_rename_op, list_recent_rename_ops as list_ops,
    pending_count_breakdown, pending_count_total, pending_for_target, pending_targets,
};
use libsql::params;

use crate::api::types::{
    FlushPendingRewritesForTargetRequest, FlushPendingRewritesRequest,
    FlushPendingRewritesResponse, GetPendingRewritesBreakdownRequest,
    GetPendingRewritesBreakdownResponse, GetPendingRewritesCountRequest,
    GetPendingRewritesCountResponse, ListRecentRenameOpsRequest, ListRecentRenameOpsResponse,
    PendingRewriteBreakdownRow, RecentRenameOp, RenameBlockIdRequest, RenameBlockIdResponse,
    RenameFileRequest, RenameFileResponse, RenameTagRequest, RenameTagResponse, UndoRenameRequest,
    UndoRenameResponse,
};
use crate::error::CubicalError;
use crate::events::{
    emit_flush_complete, emit_pending_rewrites_changed, FlushOwnWrites, Runtime,
    VaultFlushComplete, VaultPendingRewritesChanged,
};
use crate::state::AppState;

/// Config key holding the monotonically-incrementing `rename_op_id`
/// source. Stored as a JSON-encoded string (the `config` table values
/// pass through `serde_json::Value` everywhere else).
const RENAME_OP_ID_KEY: &str = "pending_rewrites.next_rename_op_id";

/// Mint the next rename_op_id, transactionally bumping the
/// `pending_rewrites.next_rename_op_id` row in `config`. First call on
/// a fresh vault returns `1`.
async fn mint_rename_op_id(vault: &cubical_core::Vault) -> Result<i64, CubicalError> {
    let conn = vault.index().connection();
    let tx = conn.transaction().await?;

    let mut rows = tx
        .query(
            "SELECT value FROM config WHERE key = ?1",
            params![RENAME_OP_ID_KEY],
        )
        .await?;
    let current: i64 = match rows.next().await? {
        Some(row) => {
            let raw: String = row.get(0)?;
            // Stored as JSON to keep `config`'s value column shape
            // consistent with every other key. A non-integer value is
            // treated as a corrupt config row (recoverable: overwrite).
            serde_json::from_str::<i64>(&raw).unwrap_or(0)
        }
        None => 0,
    };
    drop(rows);

    let next = current + 1;
    let next_str = next.to_string();
    tx.execute(
        "INSERT INTO config (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RENAME_OP_ID_KEY, next_str],
    )
    .await?;
    tx.commit().await?;
    Ok(next)
}

fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Strip a trailing `.md` if present. Wiki-link targets are stored
/// without the extension in `pending_rewrites.{old,new}_token`.
fn strip_md_suffix(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

/// Basename without the `.md` extension, e.g. `"notes/Daily.md"` →
/// `"Daily"`. Used to detect whether a wiki-link target was written as
/// a bare basename vs. a path.
fn basename_without_md(path: &str) -> &str {
    let after_slash = path.rsplit('/').next().unwrap_or(path);
    strip_md_suffix(after_slash)
}

/// Wiki-link `new_token` derivation per the design spec's locked decision.
///
/// If the referrer wrote the bare basename of `from_path`, the new
/// token is the bare basename of `to_path`. Otherwise the source wrote
/// a path-shaped target, so the new token is `to_path` without `.md`.
fn derive_wikilink_new_token(target_raw: &str, from_path: &str, to_path: &str) -> String {
    if target_raw == basename_without_md(from_path) {
        basename_without_md(to_path).to_string()
    } else {
        strip_md_suffix(to_path).to_string()
    }
}

/// Look up an open vault by id and clone its `Vault` handle out from
/// under the read lock. Each rename handler does this once at the top.
async fn clone_vault(
    state: &AppState,
    vault_id: &str,
) -> Result<cubical_core::Vault, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(vault_id.to_string()))?;
    Ok(open.vault.clone())
}

/// Look up an open vault and return both the `Vault` handle and the
/// shared `OpenVault` references the flush executor needs (own-write
/// gate + in-progress guard).
async fn clone_vault_with_flush_state(
    state: &AppState,
    vault_id: &str,
) -> Result<
    (
        cubical_core::Vault,
        FlushOwnWrites,
        std::sync::Arc<tokio::sync::Mutex<()>>,
    ),
    CubicalError,
> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(vault_id.to_string()))?;
    Ok((
        open.vault.clone(),
        open.flush_own_writes.clone(),
        open.flush_in_progress.clone(),
    ))
}

/// Spec §5.7's >50-per-file fuse. After enqueuing, if any newly-touched
/// target already exceeds 50 pending rows, flush THAT target
/// synchronously so the cache doesn't grow unbounded for a single file
/// while the rest of the vault stays deferred.
async fn enforce_fifty_per_file_fuse(
    vault: &cubical_core::Vault,
    flush_own_writes: &FlushOwnWrites,
    targets: &[String],
) -> Result<(), CubicalError> {
    for target in targets {
        let n = cubical_index::pending_count_for_target(vault.index(), target).await?;
        if n > 50 {
            flush_pending_for_target(vault, target, Some(flush_own_writes.clone())).await?;
        }
    }
    Ok(())
}

// -- Rename IPC handlers -------------------------------------------------

/// `rename_file` (L3 Session J, spec §2.10).
///
/// Single transaction:
/// 1. Resolve referrers via `SELECT DISTINCT source_path, target_raw FROM links WHERE target_path = ?from`.
/// 2. Mint a fresh `rename_op_id`.
/// 3. Insert one `pending_rewrites` row per distinct (source_path, target_raw).
/// 4. Explicit FK rekey on `links`, `tags`, `blocks`, `block_refs`,
///    `frontmatter` (none has `ON UPDATE CASCADE`).
/// 5. `UPDATE files SET path = ?to WHERE path = ?from`.
///
/// After commit: move the file on disk, re-extract the moved file's
/// outbound links/tags/blocks/frontmatter, emit
/// `vault:pending-rewrites-changed`.
pub async fn rename_file<R: Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: RenameFileRequest,
) -> Result<RenameFileResponse, CubicalError> {
    if req.from_path == req.to_path {
        return Err(CubicalError::InvalidRequest("from_path == to_path".into()));
    }
    let (vault, flush_own_writes, _flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let conn = vault.index().connection();

    // Disk-side pre-checks. The file move happens AFTER the transaction
    // commits; a stale `from_path` in the index that's already gone
    // from disk is itself a recoverable inconsistency, so we don't
    // gate on disk existence here. We DO gate on the destination not
    // already existing — clobbering would silently lose the user's
    // existing file.
    let from_abs = vault.root().join(&req.from_path);
    let to_abs = vault.root().join(&req.to_path);
    if to_abs.exists() {
        return Err(CubicalError::InvalidRequest(format!(
            "destination path already exists: {}",
            req.to_path
        )));
    }
    // Reject if from_path isn't tracked.
    let tracked: bool = {
        let mut rows = conn
            .query(
                "SELECT 1 FROM files WHERE path = ?1",
                params![req.from_path.clone()],
            )
            .await?;
        rows.next().await?.is_some()
    };
    if !tracked {
        return Err(CubicalError::FileNotFound(req.from_path.clone()));
    }

    // Resolve referrers BEFORE the transaction so the SELECT and the
    // INSERTs share a single round-trip view.
    let referrers: Vec<(String, String)> = {
        let mut rows = conn
            .query(
                "SELECT DISTINCT source_path, target_raw FROM links WHERE target_path = ?1",
                params![req.from_path.clone()],
            )
            .await?;
        let mut out: Vec<(String, String)> = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push((row.get(0)?, row.get(1)?));
        }
        out
    };

    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    // Defer FK checks to COMMIT time so the intermediate states during
    // explicit rekeys (children pointing at the new path while
    // `files.path` still holds the old one — and vice versa) don't
    // trip SQLite's default ON UPDATE NO ACTION. The setting is
    // transaction-scoped and resets on COMMIT.
    tx.execute("PRAGMA defer_foreign_keys = 1", ()).await?;
    for (source_path, target_raw) in &referrers {
        let new_token = derive_wikilink_new_token(target_raw, &req.from_path, &req.to_path);
        tx.execute(
            "INSERT INTO pending_rewrites \
             (target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id) \
             VALUES (?1, 'wiki_link', ?2, ?3, ?4, ?5)",
            params![
                source_path.clone(),
                target_raw.clone(),
                new_token,
                now,
                rename_op_id
            ],
        )
        .await?;
    }

    // Explicit FK rekey — no FK on these tables has ON UPDATE CASCADE,
    // and SQLite's default ON UPDATE NO ACTION would block the
    // `UPDATE files SET path = ?to` if any child row pointed at the
    // old path. Update children first.
    for (table, column) in [
        ("links", "source_path"),
        ("tags", "file_path"),
        ("blocks", "file_path"),
        ("block_refs", "source_file_path"),
        ("frontmatter", "file_path"),
    ] {
        let sql = format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2");
        tx.execute(&sql, params![req.to_path.clone(), req.from_path.clone()])
            .await?;
    }
    // `block_refs.target_file_path` is path-keyed too — keep stale refs
    // pointing at the new path so referrer files don't suddenly become
    // broken.
    tx.execute(
        "UPDATE block_refs SET target_file_path = ?1 WHERE target_file_path = ?2",
        params![req.to_path.clone(), req.from_path.clone()],
    )
    .await?;
    // And `links.target_path` so backlinks-for-the-new-path return
    // these rows immediately (pre-flush).
    tx.execute(
        "UPDATE links SET target_path = ?1 WHERE target_path = ?2",
        params![req.to_path.clone(), req.from_path.clone()],
    )
    .await?;

    tx.execute(
        "UPDATE files SET path = ?1 WHERE path = ?2",
        params![req.to_path.clone(), req.from_path.clone()],
    )
    .await?;
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
        // EXDEV = 18 on Linux + macOS; rename across filesystems is not
        // supported and needs a copy-then-remove fallback. Other errors
        // (missing source, permissions, dest path malformed) propagate.
        if e.raw_os_error() == Some(18) {
            let bytes = std::fs::read(&from_abs).map_err(|e| CubicalError::Io(e.to_string()))?;
            atomic_write(&to_abs, &bytes).map_err(|e| CubicalError::Io(e.to_string()))?;
            std::fs::remove_file(&from_abs).map_err(|e| CubicalError::Io(e.to_string()))?;
        } else {
            return Err(CubicalError::Io(e.to_string()));
        }
    }

    // Re-extract the moved file's outbound rows under the new path.
    // The earlier `UPDATE links / tags / blocks / frontmatter` rekeyed
    // existing rows, but the source MAY contain self-references whose
    // resolution needs to be re-derived now that the file lives at
    // `to_path` (e.g. wiki-links to the now-renamed file by basename
    // resolve differently). Best-effort: a refresh failure here is
    // surfaced as Db but the rename is already committed.
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

    // L4-B: the Tantivy search index is a separate store and the rename
    // command is its own mutation path — keep it in sync here rather than
    // relying on the watcher (which lags / may coalesce app-initiated
    // renames, leaving the old path's doc searchable). Drop the old
    // path's doc, index the new path, commit. Idempotent vs. any later
    // watcher event.
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

    // >50-per-file fuse — spec §5.7. Per-referrer-file synchronous
    // flush when the post-enqueue count for that file exceeds 50.
    let fuse_targets: Vec<String> = referrers.iter().map(|(s, _)| s.clone()).collect();
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

/// `rename_tag` (L3 Session J).
///
/// Enqueues one `Tag` row per DISTINCT `file_path` from
/// `tags WHERE tag_path = ?old OR tag_path LIKE ?old || '/%'` so nested
/// renames are captured. `apply_pending` handles the prefix rewrite.
pub async fn rename_tag<R: Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: RenameTagRequest,
) -> Result<RenameTagResponse, CubicalError> {
    if req.old_tag == req.new_tag {
        return Err(CubicalError::InvalidRequest("old_tag == new_tag".into()));
    }
    if req.old_tag.is_empty() || req.new_tag.is_empty() {
        return Err(CubicalError::InvalidRequest("tag must not be empty".into()));
    }
    let (vault, flush_own_writes, _flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let conn = vault.index().connection();

    let prefix_like = format!("{}/%", req.old_tag);
    let files: Vec<String> = {
        let mut rows = conn
            .query(
                "SELECT DISTINCT file_path FROM tags WHERE tag_path = ?1 OR tag_path LIKE ?2",
                params![req.old_tag.clone(), prefix_like],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get(0)?);
        }
        out
    };
    if files.is_empty() {
        return Ok(RenameTagResponse {
            rename_op_id: 0,
            pending_count: pending_count_total(vault.index()).await?,
        });
    }

    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    for file_path in &files {
        tx.execute(
            "INSERT INTO pending_rewrites \
             (target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id) \
             VALUES (?1, 'tag', ?2, ?3, ?4, ?5)",
            params![
                file_path.clone(),
                req.old_tag.clone(),
                req.new_tag.clone(),
                now,
                rename_op_id
            ],
        )
        .await?;
    }
    tx.commit().await?;

    enforce_fifty_per_file_fuse(&vault, &flush_own_writes, &files).await?;

    let pending_count = pending_count_total(vault.index()).await?;
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(RenameTagResponse {
        rename_op_id,
        pending_count,
    })
}

/// `rename_block_id` (L3 Session J).
///
/// Two enqueue paths share one rename_op_id:
/// - one row per DISTINCT `source_file_path` in `block_refs WHERE
///   (target_file_path, target_block_id) = (?file, ?old)` — referrer
///   pattern `[[file#^old]]`.
/// - plus one row targeting `file_path` itself — defining-line `^old`
///   rewrite handled by `apply_pending`.
///
/// Rejects when no `blocks` row exists for `(file_path, old_id)` (a
/// rename of a non-existent block is a typo, not a use case).
pub async fn rename_block_id<R: Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: RenameBlockIdRequest,
) -> Result<RenameBlockIdResponse, CubicalError> {
    if req.old_id == req.new_id {
        return Err(CubicalError::InvalidRequest("old_id == new_id".into()));
    }
    if req.old_id.is_empty() || req.new_id.is_empty() {
        return Err(CubicalError::InvalidRequest(
            "block id must not be empty".into(),
        ));
    }
    let (vault, flush_own_writes, _flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let conn = vault.index().connection();

    let exists = cubical_index::block_exists(vault.index(), &req.file_path, &req.old_id).await?;
    if !exists {
        return Err(CubicalError::InvalidRequest(format!(
            "no block ^{} in {}",
            req.old_id, req.file_path
        )));
    }

    // Referrer files.
    let referrers: Vec<String> = {
        let mut rows = conn
            .query(
                "SELECT DISTINCT source_file_path FROM block_refs \
                 WHERE target_file_path = ?1 AND target_block_id = ?2",
                params![req.file_path.clone(), req.old_id.clone()],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get(0)?);
        }
        out
    };

    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    // Defining-line target ALWAYS lands; otherwise the `^old` on the
    // defining line never gets rewritten. Use a set to deduplicate when
    // the defining file is also a referrer.
    let mut targets: Vec<String> = referrers;
    if !targets.iter().any(|p| p == &req.file_path) {
        targets.push(req.file_path.clone());
    }

    let tx = conn.transaction().await?;
    for target in &targets {
        tx.execute(
            "INSERT INTO pending_rewrites \
             (target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id) \
             VALUES (?1, 'block_ref', ?2, ?3, ?4, ?5)",
            params![
                target.clone(),
                req.old_id.clone(),
                req.new_id.clone(),
                now,
                rename_op_id
            ],
        )
        .await?;
    }
    tx.commit().await?;

    enforce_fifty_per_file_fuse(&vault, &flush_own_writes, &targets).await?;

    let pending_count = pending_count_total(vault.index()).await?;
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(RenameBlockIdResponse {
        rename_op_id,
        pending_count,
    })
}

// -- Flush executor + IPCs ----------------------------------------------

/// Per-target flush executor. Pulled out of the chain-3 stub
/// (`flush_target_for_link_mention`) and renamed here. Used by both:
/// - `flush_pending_rewrites` (iterates all `pending_targets`).
/// - `flush_pending_rewrites_for_target` (single-target manual / fuse).
/// - `link_mention` (precondition: flush the source's pending rows so
///   the splice operates on the post-rewrite text).
///
/// Returns `(file_changed, refs_updated)` so the caller can accumulate
/// flush totals.
///
/// The own-write hash gate (`flush_own_writes`) is populated BEFORE the
/// `atomic_write` so the watcher dispatcher's Modified branch can
/// suppress the bounce-back. When `flush_own_writes` is `None`
/// (no caller-supplied gate handle, e.g. `link_mention`'s precondition
/// path which doesn't need bounce-suppression because the splice that
/// follows is itself an own-write tracked through the same disk write),
/// the gate insert is skipped.
pub(crate) async fn flush_pending_for_target(
    vault: &cubical_core::Vault,
    target_file: &str,
    flush_own_writes: Option<FlushOwnWrites>,
) -> Result<(bool, usize), CubicalError> {
    let rows = pending_for_target(vault.index(), target_file).await?;
    if rows.is_empty() {
        return Ok((false, 0));
    }

    // Read the file's current on-disk bytes off the executor.
    let abs = vault.root().join(target_file);
    let on_disk_res = {
        let abs = abs.clone();
        tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs)).await
    };
    let on_disk = match on_disk_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            // External delete between enqueue and flush — drop rows
            // silently per design spec §5.7's external-write rules.
            delete_pending_for_target(vault.index(), target_file).await?;
            return Ok((false, 0));
        }
        Ok(Err(e)) => return Err(CubicalError::Io(e.to_string())),
        Err(e) => return Err(CubicalError::Io(format!("flush read task join error: {e}"))),
    };

    let materialized = apply_pending(&on_disk, &rows);
    let refs_updated = rows
        .iter()
        .filter(|r| {
            // A row "applied" when its old_token appears in the raw
            // on-disk source — the textual substitution will yield a
            // change. External writes that removed the token before
            // flush land here as no-op, the silent-drop case from §5.7.
            on_disk.contains(&r.old_token)
        })
        .count();

    if materialized == on_disk {
        delete_pending_for_target(vault.index(), target_file).await?;
        return Ok((false, refs_updated));
    }

    let new_bytes = materialized.into_bytes();
    let new_hash = sha256_bytes_hex(&new_bytes);

    // Populate the own-write gate BEFORE the write so the watcher
    // dispatcher's Modified branch sees the entry the moment the
    // filesystem event fires.
    if let Some(gate) = flush_own_writes.as_ref() {
        gate.lock()
            .await
            .insert((PathBuf::from(target_file), new_hash.clone()));
    }

    let abs_for_write = abs.clone();
    let bytes_for_write = new_bytes.clone();
    let write_res =
        tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, &bytes_for_write)).await;
    match write_res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            // Roll back the gate entry — the write didn't happen, so
            // we shouldn't suppress a future watcher event with the
            // post-write hash that never reached disk.
            if let Some(gate) = flush_own_writes.as_ref() {
                gate.lock()
                    .await
                    .remove(&(PathBuf::from(target_file), new_hash.clone()));
            }
            return Err(CubicalError::Io(e.to_string()));
        }
        Err(e) => {
            if let Some(gate) = flush_own_writes.as_ref() {
                gate.lock()
                    .await
                    .remove(&(PathBuf::from(target_file), new_hash.clone()));
            }
            return Err(CubicalError::Io(format!(
                "flush write task join error: {e}"
            )));
        }
    }

    // Drop pending rows now that the file reflects them.
    delete_pending_for_target(vault.index(), target_file).await?;

    // Best-effort eager content_hash update. Watcher echo heals races.
    let _ = vault
        .index()
        .connection()
        .execute(
            "UPDATE files SET content_hash = ?1, size_bytes = ?2 WHERE path = ?3",
            params![new_hash, new_bytes.len() as i64, target_file.to_string()],
        )
        .await;

    Ok((true, refs_updated))
}

/// Compatibility shim — `link_mention` calls in via the old name. Use
/// the new executor with no own-write gate (link_mention's own atomic
/// write is independently tracked via the editor-side hash flow).
pub(crate) async fn flush_target_for_link_mention(
    state: &AppState,
    vault_id: &str,
    target_file: &str,
) -> Result<(), CubicalError> {
    let vault = clone_vault(state, vault_id).await?;
    flush_pending_for_target(&vault, target_file, None)
        .await
        .map(|_| ())
}

/// `flush_pending_rewrites` (L3 Session J).
///
/// Iterate every `pending_targets`, flush each via the per-target
/// executor, emit `vault:flush-complete` once at the end and
/// `vault:pending-rewrites-changed` with the residual count.
pub async fn flush_pending_rewrites<R: Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: FlushPendingRewritesRequest,
) -> Result<FlushPendingRewritesResponse, CubicalError> {
    let (vault, flush_own_writes, flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let _guard = flush_in_progress.lock().await;

    let targets = pending_targets(vault.index()).await?;
    let mut files_rewritten: i64 = 0;
    let mut refs_updated: i64 = 0;
    for target in &targets {
        let (changed, n) =
            flush_pending_for_target(&vault, target, Some(flush_own_writes.clone())).await?;
        if changed {
            files_rewritten += 1;
        }
        refs_updated += n as i64;
    }

    let pending_count = pending_count_total(vault.index()).await?;
    emit_flush_complete(
        app,
        VaultFlushComplete {
            vault_id: req.vault_id.clone(),
            files_rewritten,
            refs_updated,
        },
    );
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(FlushPendingRewritesResponse {
        files_rewritten,
        refs_updated,
    })
}

/// `flush_pending_rewrites_for_target` (L3 Session J).
pub async fn flush_pending_rewrites_for_target<R: Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: FlushPendingRewritesForTargetRequest,
) -> Result<FlushPendingRewritesResponse, CubicalError> {
    let (vault, flush_own_writes, flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let _guard = flush_in_progress.lock().await;

    let (changed, refs_updated_usize) =
        flush_pending_for_target(&vault, &req.target_file, Some(flush_own_writes)).await?;
    let files_rewritten: i64 = if changed { 1 } else { 0 };
    let refs_updated = refs_updated_usize as i64;

    let pending_count = pending_count_total(vault.index()).await?;
    emit_flush_complete(
        app,
        VaultFlushComplete {
            vault_id: req.vault_id.clone(),
            files_rewritten,
            refs_updated,
        },
    );
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(FlushPendingRewritesResponse {
        files_rewritten,
        refs_updated,
    })
}

/// Internal flush entry point that drives a flush given only what the
/// timer / close-time triggers can capture from `open_vault`:
/// - the `Vault` handle (cheap-clone, owns the index connection),
/// - the per-vault `flush_own_writes` gate,
/// - the per-vault `flush_in_progress` guard.
///
/// Doesn't touch `AppState`, so the spawned timer task can call it
/// without borrowing across an `await` point.
pub(crate) async fn flush_all_for_vault<R: Runtime>(
    vault: &cubical_core::Vault,
    flush_own_writes: &FlushOwnWrites,
    flush_in_progress: &std::sync::Arc<tokio::sync::Mutex<()>>,
    app: &tauri::AppHandle<R>,
    vault_id: &str,
) -> Result<FlushPendingRewritesResponse, CubicalError> {
    let _guard = flush_in_progress.lock().await;
    let targets = pending_targets(vault.index()).await?;
    let mut files_rewritten: i64 = 0;
    let mut refs_updated: i64 = 0;
    for target in &targets {
        let (changed, n) =
            flush_pending_for_target(vault, target, Some(flush_own_writes.clone())).await?;
        if changed {
            files_rewritten += 1;
        }
        refs_updated += n as i64;
    }

    let pending_count = pending_count_total(vault.index()).await?;
    emit_flush_complete(
        app,
        VaultFlushComplete {
            vault_id: vault_id.to_string(),
            files_rewritten,
            refs_updated,
        },
    );
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: vault_id.to_string(),
            count: pending_count,
        },
    );

    Ok(FlushPendingRewritesResponse {
        files_rewritten,
        refs_updated,
    })
}

/// Config key holding the periodic-flush interval (seconds, default 300).
pub const FLUSH_INTERVAL_SECS_KEY: &str = "pending_rewrites.flush_interval_secs";

/// Default periodic flush interval if `pending_rewrites.flush_interval_secs`
/// is unset (or corrupt). Spec §5.7 / design spec default.
const DEFAULT_FLUSH_INTERVAL_SECS: u64 = 300;

/// Spawn the per-vault periodic flush timer. Reads
/// `pending_rewrites.flush_interval_secs` on each tick (so a J.2
/// settings change takes effect on the next tick, not on app restart).
/// Exits when `cancel` fires.
pub fn spawn_flush_timer<R: Runtime>(
    app: tauri::AppHandle<R>,
    vault: cubical_core::Vault,
    flush_own_writes: FlushOwnWrites,
    flush_in_progress: std::sync::Arc<tokio::sync::Mutex<()>>,
    vault_id: String,
    cancel: tokio_util::sync::CancellationToken,
) {
    tokio::spawn(async move {
        loop {
            let secs = read_flush_interval(&vault).await;
            let sleep = tokio::time::sleep(std::time::Duration::from_secs(secs));
            tokio::select! {
                _ = cancel.cancelled() => {
                    tracing::debug!(vault_id = %vault_id, "flush timer: cancelled");
                    return;
                }
                _ = sleep => {}
            }
            if let Err(e) = flush_all_for_vault(
                &vault,
                &flush_own_writes,
                &flush_in_progress,
                &app,
                &vault_id,
            )
            .await
            {
                tracing::warn!(vault_id = %vault_id, error = %e, "flush timer: tick failed");
            }
        }
    });
}

async fn read_flush_interval(vault: &cubical_core::Vault) -> u64 {
    let conn = vault.index().connection();
    let mut rows = match conn
        .query(
            "SELECT value FROM config WHERE key = ?1",
            params![FLUSH_INTERVAL_SECS_KEY],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "flush timer: config query failed; using default");
            return DEFAULT_FLUSH_INTERVAL_SECS;
        }
    };
    let raw: Option<String> = match rows.next().await {
        Ok(Some(row)) => row.get(0).ok(),
        _ => None,
    };
    raw.and_then(|s| serde_json::from_str::<u64>(&s).ok())
        .unwrap_or(DEFAULT_FLUSH_INTERVAL_SECS)
}

/// Close-time flush — drives one flush before `close_vault` drops the
/// index handle. Errors are logged and swallowed: a flush failure must
/// not block close (better to lose the pending rewrites than to wedge
/// the user; the rows persist in libSQL and the next open will see
/// them).
pub(crate) async fn flush_at_close<R: Runtime>(
    vault: &cubical_core::Vault,
    flush_own_writes: &FlushOwnWrites,
    flush_in_progress: &std::sync::Arc<tokio::sync::Mutex<()>>,
    app: &tauri::AppHandle<R>,
    vault_id: &str,
) {
    if let Err(e) =
        flush_all_for_vault(vault, flush_own_writes, flush_in_progress, app, vault_id).await
    {
        tracing::warn!(vault_id = %vault_id, error = %e, "close-time flush failed; pending rows preserved");
    }
}

// -- Read-only IPCs ------------------------------------------------------

/// `get_pending_rewrites_count` (L3 Session J).
pub async fn get_pending_rewrites_count(
    state: &AppState,
    req: GetPendingRewritesCountRequest,
) -> Result<GetPendingRewritesCountResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let count = pending_count_total(vault.index()).await?;
    Ok(GetPendingRewritesCountResponse { count })
}

/// `get_pending_rewrites_breakdown` (L3 Session J).
pub async fn get_pending_rewrites_breakdown(
    state: &AppState,
    req: GetPendingRewritesBreakdownRequest,
) -> Result<GetPendingRewritesBreakdownResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let rows = pending_count_breakdown(vault.index()).await?;
    Ok(GetPendingRewritesBreakdownResponse {
        rows: rows
            .into_iter()
            .map(|(target_file, count)| PendingRewriteBreakdownRow { target_file, count })
            .collect(),
    })
}

/// `list_recent_rename_ops` (L3 Session J).
pub async fn list_recent_rename_ops(
    state: &AppState,
    req: ListRecentRenameOpsRequest,
) -> Result<ListRecentRenameOpsResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let ops = list_ops(vault.index(), i64::from(req.limit)).await?;
    Ok(ListRecentRenameOpsResponse {
        ops: ops
            .into_iter()
            .map(|o| RecentRenameOp {
                rename_op_id: o.rename_op_id,
                kind: o.representative_kind.as_str().to_string(),
                row_count: o.row_count,
                created_at: o.created_at_min,
            })
            .collect(),
    })
}

/// `undo_rename` (L3 Session J).
///
/// Deletes every pending row belonging to `rename_op_id`. Post-flush
/// undo (full reverse rewrite) lives in L8 Time Machine — see §5.7 +
/// `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`.
pub async fn undo_rename<R: Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: UndoRenameRequest,
) -> Result<UndoRenameResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let removed = delete_rename_op(vault.index(), req.rename_op_id).await?;
    let pending_count = pending_count_total(vault.index()).await?;
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );
    Ok(UndoRenameResponse {
        removed,
        pending_count,
    })
}

// -- Tests ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{
        backlinks_for, block_exists, enqueue_pending, pending_count_for_target,
        replace_blocks_for_file, replace_links_for_file, replace_tags_for_file, BlockRow, LinkRow,
        NewPendingRewrite, RewriteKind, TagRow, TagSource,
    };
    use std::collections::HashSet;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.into(),
            OpenVault::new(
                vault.clone(),
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
            ),
        );
        (dir, vault, state)
    }

    /// Seed a tracked `files` row pointing at `path`. The path doesn't
    /// have to exist on disk unless the test also calls a handler that
    /// reads it.
    async fn seed_file(vault: &Vault, rel: &str, type_id: &str) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES (?1, ?2, 0, 0, '', NULL, 0, 0, 0)",
                params![rel, type_id],
            )
            .await
            .unwrap();
    }

    // -- mint_rename_op_id --------------------------------------------------

    #[tokio::test]
    async fn mint_rename_op_id_returns_monotonic_sequence_from_one() {
        let (_d, vault, _state) = fresh("v1").await;
        assert_eq!(mint_rename_op_id(&vault).await.unwrap(), 1);
        assert_eq!(mint_rename_op_id(&vault).await.unwrap(), 2);
        assert_eq!(mint_rename_op_id(&vault).await.unwrap(), 3);
    }

    // -- wikilink token derivation -----------------------------------------

    #[test]
    fn wikilink_new_token_basename_form() {
        // [[Daily]] → renamed to notes/Journal.md → new_token = "Journal"
        let got = derive_wikilink_new_token("Daily", "notes/Daily.md", "notes/Journal.md");
        assert_eq!(got, "Journal");
    }

    #[test]
    fn wikilink_new_token_path_form() {
        // [[notes/Daily]] → renamed to archive/Journal.md → new_token = "archive/Journal"
        let got = derive_wikilink_new_token("notes/Daily", "notes/Daily.md", "archive/Journal.md");
        assert_eq!(got, "archive/Journal");
    }

    // -- rename_file --------------------------------------------------------

    /// Build a no-op `AppHandle` for handlers that emit events. Tauri's
    /// `Emitter::emit` returns `Err` when no listeners exist but the
    /// emit helper logs and swallows that, so the tests don't need a
    /// real handle. The handlers take `&AppHandle`; we satisfy the type
    /// with `tauri::test::mock_app().handle().clone()`.
    fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        tauri::test::mock_app().handle().clone()
    }

    #[tokio::test]
    async fn rename_file_enqueues_one_row_per_distinct_referrer_pair() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        seed_file(&vault, "Project.md", "markdown").await;
        seed_file(&vault, "Notes.md", "markdown").await;
        // Project.md has TWO references to Daily — same (source, target_raw)
        // so they collapse into one pending row.
        replace_links_for_file(
            vault.index(),
            "Project.md",
            &[
                LinkRow {
                    target_raw: "Daily".into(),
                    target_path: Some("Daily.md".into()),
                    anchor_kind: None,
                    anchor_value: None,
                    display_text: None,
                    is_embed: false,
                    position: 0,
                },
                LinkRow {
                    target_raw: "Daily".into(),
                    target_path: Some("Daily.md".into()),
                    anchor_kind: None,
                    anchor_value: None,
                    display_text: None,
                    is_embed: false,
                    position: 50,
                },
            ],
        )
        .await
        .unwrap();
        // Notes.md uses the path form — same target_path but different
        // target_raw → distinct pending row.
        replace_links_for_file(
            vault.index(),
            "Notes.md",
            &[LinkRow {
                target_raw: "Daily".into(),
                target_path: Some("Daily.md".into()),
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 0,
            }],
        )
        .await
        .unwrap();
        // Create the disk file so rename_file's rename can move it.
        std::fs::write(vault.root().join("Daily.md"), "body\n").unwrap();

        let resp = rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.rename_op_id, 1);
        assert_eq!(resp.pending_count, 2, "Project + Notes = 2 distinct rows");
        // Both rows live and target the right source files.
        let p = pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].old_token, "Daily");
        assert_eq!(p[0].new_token, "Journal");
        let n = pending_for_target(vault.index(), "Notes.md").await.unwrap();
        assert_eq!(n.len(), 1);
    }

    #[tokio::test]
    async fn rename_file_keeps_search_index_in_sync() {
        use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        let body = "uniquetoken body\n";
        std::fs::write(vault.root().join("Daily.md"), body).unwrap();
        // Index the file under its current path so it is searchable.
        refresh_search_index(&vault, "Daily.md", body, 0, body.len() as u64)
            .await
            .unwrap();
        vault.search().commit().unwrap();

        let q = |text: &str| SearchQuery {
            text: text.into(),
            limit: 0,
            offset: 0,
            fields: FieldScope::Default,
            fuzzy: false,
            sort: SortMode::Relevance,
        };
        let before = run_search(vault.search(), &q("uniquetoken")).unwrap();
        assert_eq!(before.hits.len(), 1);
        assert_eq!(before.hits[0].path, "Daily.md");

        rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

        // The search index must follow the rename: new path indexed, old
        // path dropped — not left stale for the watcher to maybe fix.
        let after = run_search(vault.search(), &q("uniquetoken")).unwrap();
        assert_eq!(after.hits.len(), 1, "exactly one doc after rename");
        assert_eq!(
            after.hits[0].path, "Journal.md",
            "doc must be searchable under the new path"
        );
        assert!(
            after.hits.iter().all(|h| h.path != "Daily.md"),
            "old path must be dropped from the search index"
        );
    }

    #[tokio::test]
    async fn rename_file_explicit_rekeys_fk_tables_to_new_path() {
        // After the rename's explicit-rekey transaction, every row in
        // the FK-bearing children must point at `to_path` rather than
        // `from_path`. Use disk content carrying real tags + a real
        // block id so the post-rename `refresh_*` calls keep the rows
        // we're checking (a synthetic row that doesn't match the body
        // would be wiped by `refresh_tags`).
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        std::fs::write(
            vault.root().join("Daily.md"),
            "#planning body\n\nsomething ^intro\n",
        )
        .unwrap();
        // Seed the index rows directly so we don't rely on the watcher
        // having run — rename is the unit under test.
        replace_tags_for_file(
            vault.index(),
            "Daily.md",
            &[TagRow {
                tag_path: "planning".into(),
                source: TagSource::Inline,
            }],
        )
        .await
        .unwrap();
        replace_blocks_for_file(
            vault.index(),
            "Daily.md",
            &[BlockRow {
                block_id: "intro".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();

        rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

        // tags FK rekeyed.
        let conn = vault.index().connection();
        let mut rows = conn
            .query("SELECT file_path FROM tags WHERE tag_path = 'planning'", ())
            .await
            .unwrap();
        let row = rows
            .next()
            .await
            .unwrap()
            .expect("tags row survives rename");
        let fp: String = row.get(0).unwrap();
        assert_eq!(fp, "Journal.md");

        // blocks FK rekeyed (existence check via the helper).
        assert!(block_exists(vault.index(), "Journal.md", "intro")
            .await
            .unwrap());
        assert!(!block_exists(vault.index(), "Daily.md", "intro")
            .await
            .unwrap());

        // files.path itself is the new path.
        let mut rows = conn
            .query("SELECT path FROM files WHERE path = 'Journal.md'", ())
            .await
            .unwrap();
        assert!(rows.next().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn rename_file_moves_the_file_on_disk() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        std::fs::write(vault.root().join("a.md"), "hi\n").unwrap();

        rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect("ok");

        assert!(!vault.root().join("a.md").exists());
        assert_eq!(
            std::fs::read_to_string(vault.root().join("b.md")).unwrap(),
            "hi\n"
        );
    }

    #[tokio::test]
    async fn rename_file_rejects_same_path_and_existing_destination() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "b.md", "markdown").await;
        std::fs::write(vault.root().join("a.md"), "a\n").unwrap();
        std::fs::write(vault.root().join("b.md"), "b\n").unwrap();

        let err = rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "a.md".into(),
            },
        )
        .await
        .expect_err("same path must reject");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));

        let err = rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect_err("existing dest must reject");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn rename_file_links_target_path_rekeys_too() {
        // After rename, backlinks-for-the-new-path must see the rows
        // immediately (the materialize-on-read view shows the new name
        // before flush, but the index needs to agree).
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        seed_file(&vault, "Project.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Project.md",
            &[LinkRow {
                target_raw: "Daily".into(),
                target_path: Some("Daily.md".into()),
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 0,
            }],
        )
        .await
        .unwrap();
        std::fs::write(vault.root().join("Daily.md"), "body\n").unwrap();

        rename_file(
            &state,
            &mock_app(),
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

        // backlinks pointing at the new path return the existing link.
        let rows = backlinks_for(vault.index(), "Journal.md").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_path, "Project.md");
    }

    // -- rename_tag ---------------------------------------------------------

    #[tokio::test]
    async fn rename_tag_enqueues_one_row_per_distinct_referrer_file() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "b.md", "markdown").await;
        seed_file(&vault, "c.md", "markdown").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[
                TagRow {
                    tag_path: "planning".into(),
                    source: TagSource::Inline,
                },
                // Same file referencing the same tag twice → 1 row.
                TagRow {
                    tag_path: "planning".into(),
                    source: TagSource::Inline,
                },
            ],
        )
        .await
        .unwrap();
        replace_tags_for_file(
            vault.index(),
            "b.md",
            &[TagRow {
                tag_path: "planning/active".into(),
                source: TagSource::Inline,
            }],
        )
        .await
        .unwrap();
        // c.md doesn't use the tag → no row.
        replace_tags_for_file(
            vault.index(),
            "c.md",
            &[TagRow {
                tag_path: "unrelated".into(),
                source: TagSource::Inline,
            }],
        )
        .await
        .unwrap();

        let resp = rename_tag(
            &state,
            &mock_app(),
            RenameTagRequest {
                vault_id: "v1".into(),
                old_tag: "planning".into(),
                new_tag: "scheduling".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.rename_op_id, 1);
        assert_eq!(resp.pending_count, 2, "a + b = 2 distinct files");

        // No row for c.md.
        assert!(pending_for_target(vault.index(), "c.md")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn rename_tag_with_no_referrers_returns_zero_op_id_and_skips_enqueue() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[TagRow {
                tag_path: "unrelated".into(),
                source: TagSource::Inline,
            }],
        )
        .await
        .unwrap();

        let resp = rename_tag(
            &state,
            &mock_app(),
            RenameTagRequest {
                vault_id: "v1".into(),
                old_tag: "ghost".into(),
                new_tag: "g2".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.rename_op_id, 0);
        assert_eq!(resp.pending_count, 0);
    }

    // -- rename_block_id ----------------------------------------------------

    #[tokio::test]
    async fn rename_block_id_enqueues_referrers_plus_defining_file() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Pinned.md", "markdown").await;
        seed_file(&vault, "Refs.md", "markdown").await;
        // The defining block.
        replace_blocks_for_file(
            vault.index(),
            "Pinned.md",
            &[BlockRow {
                block_id: "anchor".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();
        // Refs.md references Pinned.md#^anchor.
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO block_refs (source_file_path, target_file_path, target_block_id) \
                 VALUES ('Refs.md', 'Pinned.md', 'anchor')",
                (),
            )
            .await
            .unwrap();

        let resp = rename_block_id(
            &state,
            &mock_app(),
            RenameBlockIdRequest {
                vault_id: "v1".into(),
                file_path: "Pinned.md".into(),
                old_id: "anchor".into(),
                new_id: "pinned".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.rename_op_id, 1);
        assert_eq!(
            resp.pending_count, 2,
            "Refs.md (referrer) + Pinned.md (defining)"
        );

        // Both files have one pending row.
        assert_eq!(
            pending_for_target(vault.index(), "Refs.md")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            pending_for_target(vault.index(), "Pinned.md")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn rename_block_id_rejects_unknown_id() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Pinned.md", "markdown").await;
        // No blocks row for "ghost".
        let err = rename_block_id(
            &state,
            &mock_app(),
            RenameBlockIdRequest {
                vault_id: "v1".into(),
                file_path: "Pinned.md".into(),
                old_id: "ghost".into(),
                new_id: "g2".into(),
            },
        )
        .await
        .expect_err("must reject");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn rename_block_id_dedupes_when_defining_file_is_also_a_referrer() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Self.md", "markdown").await;
        replace_blocks_for_file(
            vault.index(),
            "Self.md",
            &[BlockRow {
                block_id: "a".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();
        // Self.md references its own block.
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO block_refs (source_file_path, target_file_path, target_block_id) \
                 VALUES ('Self.md', 'Self.md', 'a')",
                (),
            )
            .await
            .unwrap();

        let resp = rename_block_id(
            &state,
            &mock_app(),
            RenameBlockIdRequest {
                vault_id: "v1".into(),
                file_path: "Self.md".into(),
                old_id: "a".into(),
                new_id: "b".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.pending_count, 1, "deduped");
    }

    // -- flush_pending_for_target ------------------------------------------

    #[tokio::test]
    async fn flush_noop_when_no_pending_rows() {
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "body\n").unwrap();
        let (changed, refs) = flush_pending_for_target(&vault, "A.md", None)
            .await
            .unwrap();
        assert!(!changed);
        assert_eq!(refs, 0);
        let s = std::fs::read_to_string(vault.root().join("A.md")).unwrap();
        assert_eq!(s, "body\n");
    }

    #[tokio::test]
    async fn flush_writes_materialized_source_and_drops_rows() {
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("Project.md"), "see [[Daily]] today\n").unwrap();
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Project.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "Daily".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let (changed, refs) = flush_pending_for_target(&vault, "Project.md", None)
            .await
            .unwrap();
        assert!(changed);
        assert_eq!(refs, 1);

        let s = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(s, "see [[Journal]] today\n");
        assert!(pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn flush_silent_drops_when_old_token_was_removed_externally() {
        let (_d, vault, _state) = fresh("v1").await;
        // Disk no longer contains the old token (external edit removed it).
        std::fs::write(vault.root().join("Project.md"), "unrelated content\n").unwrap();
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Project.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "Daily".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let (changed, refs) = flush_pending_for_target(&vault, "Project.md", None)
            .await
            .unwrap();
        assert!(!changed);
        assert_eq!(refs, 0, "no row contributed");
        // Pending row still gone — the silent-drop semantic per §5.7.
        assert!(pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn flush_populates_own_write_gate_with_post_write_hash() {
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("Project.md"), "see [[Daily]]\n").unwrap();
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Project.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "Daily".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let gate: FlushOwnWrites = std::sync::Arc::new(tokio::sync::Mutex::new(HashSet::new()));

        flush_pending_for_target(&vault, "Project.md", Some(gate.clone()))
            .await
            .unwrap();

        // Compute expected hash from the post-write bytes.
        let written = std::fs::read(vault.root().join("Project.md")).unwrap();
        let expected_hash = sha256_bytes_hex(&written);
        let entries = gate.lock().await;
        assert!(
            entries.contains(&(PathBuf::from("Project.md"), expected_hash)),
            "gate must contain the post-write hash entry",
        );
    }

    #[tokio::test]
    async fn flush_silently_drops_rows_for_externally_deleted_target_file() {
        let (_d, vault, _state) = fresh("v1").await;
        // Don't create the target file at all → ENOENT path.
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Gone.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "x".into(),
                new_token: "y".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let (changed, refs) = flush_pending_for_target(&vault, "Gone.md", None)
            .await
            .unwrap();
        assert!(!changed);
        assert_eq!(refs, 0);
        assert!(pending_for_target(vault.index(), "Gone.md")
            .await
            .unwrap()
            .is_empty());
    }

    // -- flush IPCs --------------------------------------------------------

    #[tokio::test]
    async fn flush_pending_rewrites_drains_all_targets() {
        let (_d, vault, state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "see [[X]]\n").unwrap();
        std::fs::write(vault.root().join("B.md"), "see [[X]]\n").unwrap();
        enqueue_pending(
            vault.index(),
            &[
                NewPendingRewrite {
                    target_file: "A.md".into(),
                    rewrite_kind: RewriteKind::WikiLink,
                    old_token: "X".into(),
                    new_token: "Y".into(),
                    created_at: 0,
                    rename_op_id: 1,
                },
                NewPendingRewrite {
                    target_file: "B.md".into(),
                    rewrite_kind: RewriteKind::WikiLink,
                    old_token: "X".into(),
                    new_token: "Y".into(),
                    created_at: 0,
                    rename_op_id: 1,
                },
            ],
        )
        .await
        .unwrap();

        let resp = flush_pending_rewrites(
            &state,
            &mock_app(),
            FlushPendingRewritesRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.files_rewritten, 2);
        assert_eq!(resp.refs_updated, 2);
        assert_eq!(pending_count_total(vault.index()).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn undo_rename_removes_only_matching_op() {
        let (_d, vault, state) = fresh("v1").await;
        enqueue_pending(
            vault.index(),
            &[
                NewPendingRewrite {
                    target_file: "A.md".into(),
                    rewrite_kind: RewriteKind::WikiLink,
                    old_token: "X".into(),
                    new_token: "Y".into(),
                    created_at: 0,
                    rename_op_id: 1,
                },
                NewPendingRewrite {
                    target_file: "B.md".into(),
                    rewrite_kind: RewriteKind::WikiLink,
                    old_token: "X".into(),
                    new_token: "Y".into(),
                    created_at: 0,
                    rename_op_id: 2,
                },
            ],
        )
        .await
        .unwrap();

        let resp = undo_rename(
            &state,
            &mock_app(),
            UndoRenameRequest {
                vault_id: "v1".into(),
                rename_op_id: 1,
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.removed, 1);
        assert_eq!(resp.pending_count, 1);

        // Op 2 untouched.
        let n = pending_count_for_target(vault.index(), "B.md")
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    // -- triggers: periodic timer / close / >50 fuse ----------------------

    #[tokio::test]
    async fn fifty_per_file_fuse_flushes_only_the_offending_target() {
        // Enqueue 51 rows for A.md and 1 for B.md, then run the fuse.
        // A.md must drain; B.md must stay queued.
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(
            vault.root().join("A.md"),
            // Repeat the old token a couple of times so the textual
            // substitution actually has something to chew on. The fuse
            // counts pending ROWS, not occurrences in source.
            "[[X]] [[X]] [[X]]\n",
        )
        .unwrap();
        std::fs::write(vault.root().join("B.md"), "[[X]]\n").unwrap();

        let mut rows = Vec::new();
        for op in 0..51 {
            rows.push(NewPendingRewrite {
                target_file: "A.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "X".into(),
                new_token: "Y".into(),
                created_at: op,
                rename_op_id: op + 1,
            });
        }
        rows.push(NewPendingRewrite {
            target_file: "B.md".into(),
            rewrite_kind: RewriteKind::WikiLink,
            old_token: "X".into(),
            new_token: "Y".into(),
            created_at: 100,
            rename_op_id: 1000,
        });
        enqueue_pending(vault.index(), &rows).await.unwrap();
        assert_eq!(
            pending_count_for_target(vault.index(), "A.md")
                .await
                .unwrap(),
            51
        );

        let gate: FlushOwnWrites = std::sync::Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        enforce_fifty_per_file_fuse(&vault, &gate, &["A.md".into(), "B.md".into()])
            .await
            .unwrap();

        // A.md drained; B.md still queued (count = 1 is NOT > 50).
        assert_eq!(
            pending_count_for_target(vault.index(), "A.md")
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            pending_count_for_target(vault.index(), "B.md")
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn fifty_per_file_fuse_does_not_fire_at_exactly_fifty() {
        // Boundary check: count must EXCEED 50 to trigger.
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "[[X]]\n").unwrap();
        let rows: Vec<_> = (0..50)
            .map(|i| NewPendingRewrite {
                target_file: "A.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "X".into(),
                new_token: "Y".into(),
                created_at: i,
                rename_op_id: i + 1,
            })
            .collect();
        enqueue_pending(vault.index(), &rows).await.unwrap();
        let gate: FlushOwnWrites = std::sync::Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        enforce_fifty_per_file_fuse(&vault, &gate, &["A.md".into()])
            .await
            .unwrap();
        assert_eq!(
            pending_count_for_target(vault.index(), "A.md")
                .await
                .unwrap(),
            50
        );
    }

    #[tokio::test]
    async fn flush_all_for_vault_drains_every_target() {
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "[[X]]\n").unwrap();
        std::fs::write(vault.root().join("B.md"), "[[X]]\n").unwrap();
        enqueue_pending(
            vault.index(),
            &[
                NewPendingRewrite {
                    target_file: "A.md".into(),
                    rewrite_kind: RewriteKind::WikiLink,
                    old_token: "X".into(),
                    new_token: "Y".into(),
                    created_at: 0,
                    rename_op_id: 1,
                },
                NewPendingRewrite {
                    target_file: "B.md".into(),
                    rewrite_kind: RewriteKind::WikiLink,
                    old_token: "X".into(),
                    new_token: "Y".into(),
                    created_at: 0,
                    rename_op_id: 1,
                },
            ],
        )
        .await
        .unwrap();

        let gate: FlushOwnWrites = std::sync::Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        let guard: std::sync::Arc<tokio::sync::Mutex<()>> =
            std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let resp = flush_all_for_vault(&vault, &gate, &guard, &mock_app(), "v1")
            .await
            .unwrap();
        assert_eq!(resp.files_rewritten, 2);
        assert_eq!(resp.refs_updated, 2);
        assert_eq!(pending_count_total(vault.index()).await.unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(vault.root().join("A.md")).unwrap(),
            "[[Y]]\n"
        );
        assert_eq!(
            std::fs::read_to_string(vault.root().join("B.md")).unwrap(),
            "[[Y]]\n"
        );
    }

    #[tokio::test]
    async fn periodic_flush_timer_fires_on_interval_then_stops_on_cancel() {
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "[[X]]\n").unwrap();
        // Set the interval to 1s so the test doesn't spin for 5 minutes.
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO config (key, value) VALUES (?1, ?2)",
                params![FLUSH_INTERVAL_SECS_KEY, "1"],
            )
            .await
            .unwrap();
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "A.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "X".into(),
                new_token: "Y".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let gate: FlushOwnWrites = std::sync::Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        let guard: std::sync::Arc<tokio::sync::Mutex<()>> =
            std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let cancel = CancellationToken::new();

        spawn_flush_timer(
            mock_app(),
            vault.clone(),
            gate.clone(),
            guard.clone(),
            "v1".into(),
            cancel.clone(),
        );

        // Wait up to 3s for the timer to tick.
        let mut drained = false;
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if pending_count_total(vault.index()).await.unwrap() == 0 {
                drained = true;
                break;
            }
        }
        cancel.cancel();
        assert!(drained, "periodic timer must have flushed within 3s");
    }
}
