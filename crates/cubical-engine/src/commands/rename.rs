use std::collections::HashSet;

use cubical_core::vault::pending::apply_pending;
use cubical_core::vault::search_refresh::{delete_search_index, refresh_search_index_with_doc};
use cubical_core::{
    atomic_write, parse_off_executor, refresh_block_refs_for_file, refresh_blocks,
    refresh_frontmatter_with_doc, refresh_links_with_doc, refresh_tags_with_doc, sha256_bytes_hex,
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
    RenameFileRequest, RenameFileResponse, RenameFolderRequest, RenameFolderResponse,
    RenameTagRequest, RenameTagResponse, UndoRenameRequest, UndoRenameResponse,
};
use crate::commands::link_match::{basename_without_md, link_name_forms, strip_md_suffix};
use crate::error::CubicalError;
use crate::events::{
    emit_flush_complete, emit_pending_rewrites_changed, EventSink, FlushOwnWrites,
    VaultFlushComplete, VaultPendingRewritesChanged,
};
use crate::state::AppState;

const RENAME_OP_ID_KEY: &str = "pending_rewrites.next_rename_op_id";

pub(super) async fn mint_rename_op_id(vault: &cubical_core::Vault) -> Result<i64, CubicalError> {
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

pub(super) fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn derive_wikilink_new_token(target_raw: &str, from_path: &str, to_path: &str) -> String {
    if target_raw == basename_without_md(from_path) {
        basename_without_md(to_path).to_string()
    } else {
        strip_md_suffix(to_path).to_string()
    }
}

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

pub(super) async fn clone_vault_with_flush_state(
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

pub(super) async fn enqueue_coalesced(
    tx: &libsql::Transaction,
    target_file: &str,
    rewrite_kind: &str,
    old_token: &str,
    new_token: &str,
    now: i64,
    rename_op_id: i64,
) -> Result<(), CubicalError> {
    let existing_id: Option<i64> = {
        let mut rows = tx
            .query(
                "SELECT id FROM pending_rewrites \
                 WHERE target_file = ?1 AND rewrite_kind = ?2 AND old_token = ?3",
                params![target_file, rewrite_kind, old_token],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Some(row.get(0)?),
            None => None,
        }
    };

    match existing_id {
        Some(id) if new_token == old_token => {
            tx.execute("DELETE FROM pending_rewrites WHERE id = ?1", params![id])
                .await?;
        }
        Some(id) => {
            tx.execute(
                "UPDATE pending_rewrites \
                 SET new_token = ?1, created_at = ?2, rename_op_id = ?3 WHERE id = ?4",
                params![new_token, now, rename_op_id, id],
            )
            .await?;
        }
        None if new_token == old_token => {}
        None => {
            tx.execute(
                "INSERT INTO pending_rewrites \
                 (target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    target_file,
                    rewrite_kind,
                    old_token,
                    new_token,
                    now,
                    rename_op_id
                ],
            )
            .await?;
        }
    }
    Ok(())
}

pub const WIKILINKS_REWRITE_BROKEN_KEY: &str = "wikilinks.rewrite_broken_links_on_rename";

async fn read_bool_setting(state: &AppState, vault_id: &str, key: &str, default: bool) -> bool {
    let guard = state.vaults().read().await;
    let Some(open) = guard.get(vault_id) else {
        return default;
    };
    let map = open.settings.read().await;
    map.get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(default)
}

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

struct RenameCommitInput<'a> {
    vault: &'a cubical_core::Vault,
    flush_own_writes: &'a FlushOwnWrites,
    vault_id: &'a str,
    from_path: &'a str,
    to_path: &'a str,
    kind: &'a str,
    rewrite_broken: bool,
}

struct RenameCommit {
    rename_op_id: i64,
    pending_count: i64,
}

async fn commit_rename(
    app: &dyn EventSink,
    input: RenameCommitInput<'_>,
) -> Result<RenameCommit, CubicalError> {
    let RenameCommitInput {
        vault,
        flush_own_writes,
        vault_id,
        from_path,
        to_path,
        kind,
        rewrite_broken,
    } = input;
    let conn = vault.index().connection();
    let to_abs = vault.root().join(to_path);

    let referrers = collect_referrers(conn, from_path, rewrite_broken).await?;

    let rename_op_id = mint_rename_op_id(vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    tx.execute("PRAGMA defer_foreign_keys = 1", ()).await?;
    let fuse_targets =
        enqueue_referrers_in_tx(&tx, from_path, to_path, &referrers, now, rename_op_id).await?;
    rekey_file_in_tx(&tx, from_path, to_path, rewrite_broken).await?;
    tx.commit().await?;

    if let Err(e) = cubical_core::vault::rename_journal::append_entry(
        vault.root(),
        &cubical_core::vault::rename_journal::RenameJournalEntry {
            op_id: rename_op_id,
            kind: kind.to_string(),
            from: from_path.to_string(),
            to: to_path.to_string(),
            at: now,
        },
    ) {
        tracing::warn!(error = %e, "rename: failed to write durability journal");
    }

    let raw_bytes = tokio::task::spawn_blocking({
        let to_abs = to_abs.clone();
        move || std::fs::read(&to_abs)
    })
    .await
    .map_err(|e| CubicalError::Io(format!("re-extract read join error: {e}")))?
    .map_err(|e| CubicalError::Io(e.to_string()))?;
    let byte_len = raw_bytes.len() as u64;
    let text = String::from_utf8(raw_bytes).ok();

    let _ = delete_search_index(vault, from_path).await;

    if let Some(on_disk) = text.as_deref() {
        let doc = parse_off_executor(on_disk).await.unwrap_or_default();
        let _ = refresh_frontmatter_with_doc(vault, to_path, &doc).await;
        let _ = refresh_links_with_doc(vault, to_path, &doc).await;
        let _ = refresh_tags_with_doc(vault, to_path, &doc).await;
        let _ = refresh_blocks(vault, to_path, on_disk).await;
        let _ = refresh_block_refs_for_file(vault, to_path).await;

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
            .unwrap_or((0, byte_len));
        let _ = refresh_search_index_with_doc(vault, to_path, &doc, mtime_secs, size_bytes).await;
    } else {
        tracing::debug!(
            path = %to_path,
            "rename: destination is not valid UTF-8; skipping content re-extraction",
        );
    }
    let _ = vault.search().commit();

    enforce_fifty_per_file_fuse(vault, flush_own_writes, &fuse_targets).await?;

    let pending_count = pending_count_total(vault.index()).await?;
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: vault_id.to_string(),
            count: pending_count,
        },
    );

    Ok(RenameCommit {
        rename_op_id,
        pending_count,
    })
}

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

    let rewrite_broken =
        read_bool_setting(state, &req.vault_id, WIKILINKS_REWRITE_BROKEN_KEY, true).await;
    let committed = commit_rename(
        app,
        RenameCommitInput {
            vault: &vault,
            flush_own_writes: &flush_own_writes,
            vault_id: &req.vault_id,
            from_path: &req.from_path,
            to_path: &req.to_path,
            kind: "file",
            rewrite_broken,
        },
    )
    .await?;

    Ok(RenameFileResponse {
        rename_op_id: committed.rename_op_id,
        pending_count: committed.pending_count,
    })
}

pub(crate) struct AdoptExternalRenameInput<'a> {
    pub vault: &'a cubical_core::Vault,
    pub flush_own_writes: &'a FlushOwnWrites,
    pub vault_id: &'a str,
    pub from_path: &'a str,
    pub to_path: &'a str,
    pub rewrite_broken: bool,
}

pub(crate) async fn adopt_external_rename(
    app: &dyn EventSink,
    input: AdoptExternalRenameInput<'_>,
) -> Result<bool, CubicalError> {
    let AdoptExternalRenameInput {
        vault,
        flush_own_writes,
        vault_id,
        from_path,
        to_path,
        rewrite_broken,
    } = input;

    if from_path == to_path || from_path.is_empty() || to_path.is_empty() {
        return Ok(false);
    }
    if !vault.root().join(to_path).is_file() || vault.root().join(from_path).exists() {
        return Ok(false);
    }

    let conn = vault.index().connection();
    if !path_tracked(conn, from_path).await? || path_tracked(conn, to_path).await? {
        return Ok(false);
    }

    commit_rename(
        app,
        RenameCommitInput {
            vault,
            flush_own_writes,
            vault_id,
            from_path,
            to_path,
            kind: "file",
            rewrite_broken,
        },
    )
    .await?;
    Ok(true)
}

type FolderRenamePlan = (String, String, Vec<(String, String)>);

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

    let mut plans: Vec<FolderRenamePlan> = Vec::with_capacity(file_paths.len());
    for from in &file_paths {
        let referrers = collect_referrers(conn, from, rewrite_broken).await?;
        plans.push((from.clone(), path_map[from].clone(), referrers));
    }

    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    tx.execute("PRAGMA defer_foreign_keys = 1", ()).await?;

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

    let mut fuse_targets: Vec<String> = Vec::new();
    for (from, to, referrers) in &plans {
        let resolved: Vec<(String, String)> = referrers
            .iter()
            .map(|(source, raw)| {
                let resolved_source = path_map
                    .get(source)
                    .cloned()
                    .unwrap_or_else(|| source.clone());
                (resolved_source, raw.clone())
            })
            .collect();
        let touched = enqueue_referrers_in_tx(&tx, from, to, &resolved, now, rename_op_id).await?;
        fuse_targets.extend(touched);
    }

    tx.commit().await?;

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
        let doc = parse_off_executor(&on_disk).await.unwrap_or_default();
        let _ = refresh_frontmatter_with_doc(&vault, to, &doc).await;
        let _ = refresh_links_with_doc(&vault, to, &doc).await;
        let _ = refresh_tags_with_doc(&vault, to, &doc).await;
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
        let _ = refresh_search_index_with_doc(&vault, to, &doc, mtime_secs, size_bytes).await;
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

pub async fn rename_tag(
    state: &AppState,
    app: &dyn EventSink,
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
        enqueue_coalesced(
            &tx,
            file_path,
            "tag",
            &req.old_tag,
            &req.new_tag,
            now,
            rename_op_id,
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

pub async fn rename_block_id(
    state: &AppState,
    app: &dyn EventSink,
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

    let mut targets: Vec<String> = referrers;
    if !targets.iter().any(|p| p == &req.file_path) {
        targets.push(req.file_path.clone());
    }

    let tx = conn.transaction().await?;
    for target in &targets {
        enqueue_coalesced(
            &tx,
            target,
            "block_ref",
            &req.old_id,
            &req.new_id,
            now,
            rename_op_id,
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

pub(crate) async fn flush_pending_for_target(
    vault: &cubical_core::Vault,
    target_file: &str,
    flush_own_writes: Option<FlushOwnWrites>,
) -> Result<(bool, usize), CubicalError> {
    let rows = pending_for_target(vault.index(), target_file).await?;
    if rows.is_empty() {
        return Ok((false, 0));
    }

    let abs = vault.root().join(target_file);
    let on_disk_res = {
        let abs = abs.clone();
        tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs)).await
    };
    let on_disk = match on_disk_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            delete_pending_for_target(vault.index(), target_file).await?;
            return Ok((false, 0));
        }
        Ok(Err(e)) => return Err(CubicalError::Io(e.to_string())),
        Err(e) => return Err(CubicalError::Io(format!("flush read task join error: {e}"))),
    };

    let materialized = apply_pending(&on_disk, &rows);
    let refs_updated = rows
        .iter()
        .filter(|r| on_disk.contains(&r.old_token))
        .count();

    if materialized == on_disk {
        delete_pending_for_target(vault.index(), target_file).await?;
        return Ok((false, refs_updated));
    }

    let new_bytes = materialized.into_bytes();
    let new_hash = sha256_bytes_hex(&new_bytes);

    if let Some(gate) = flush_own_writes.as_ref() {
        gate.lock()
            .await
            .insert((target_file.to_string(), new_hash.clone()));
    }

    let abs_for_write = abs.clone();
    let bytes_for_write = new_bytes.clone();
    let write_res =
        tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, &bytes_for_write)).await;
    match write_res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            if let Some(gate) = flush_own_writes.as_ref() {
                gate.lock()
                    .await
                    .remove(&(target_file.to_string(), new_hash.clone()));
            }
            return Err(CubicalError::Io(e.to_string()));
        }
        Err(e) => {
            if let Some(gate) = flush_own_writes.as_ref() {
                gate.lock()
                    .await
                    .remove(&(target_file.to_string(), new_hash.clone()));
            }
            return Err(CubicalError::Io(format!(
                "flush write task join error: {e}"
            )));
        }
    }

    delete_pending_for_target(vault.index(), target_file).await?;

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

pub async fn flush_pending_rewrites(
    state: &AppState,
    app: &dyn EventSink,
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
    prune_materialized_journal(&vault).await;

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

pub async fn flush_pending_rewrites_for_target(
    state: &AppState,
    app: &dyn EventSink,
    req: FlushPendingRewritesForTargetRequest,
) -> Result<FlushPendingRewritesResponse, CubicalError> {
    let (vault, flush_own_writes, flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let _guard = flush_in_progress.lock().await;

    let (changed, refs_updated_usize) =
        flush_pending_for_target(&vault, &req.target_file, Some(flush_own_writes)).await?;
    let files_rewritten: i64 = if changed { 1 } else { 0 };
    let refs_updated = refs_updated_usize as i64;
    prune_materialized_journal(&vault).await;

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

pub(crate) async fn flush_all_for_vault(
    vault: &cubical_core::Vault,
    flush_own_writes: &FlushOwnWrites,
    flush_in_progress: &std::sync::Arc<tokio::sync::Mutex<()>>,
    app: &dyn EventSink,
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
    prune_materialized_journal(vault).await;

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

pub const FLUSH_INTERVAL_SECS_KEY: &str = "pending_rewrites.flush_interval_secs";

const DEFAULT_FLUSH_INTERVAL_SECS: u64 = 300;

pub fn spawn_flush_timer(
    app: std::sync::Arc<dyn EventSink>,
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
                app.as_ref(),
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

pub(crate) async fn flush_at_close(
    vault: &cubical_core::Vault,
    flush_own_writes: &FlushOwnWrites,
    flush_in_progress: &std::sync::Arc<tokio::sync::Mutex<()>>,
    app: &dyn EventSink,
    vault_id: &str,
) {
    if let Err(e) =
        flush_all_for_vault(vault, flush_own_writes, flush_in_progress, app, vault_id).await
    {
        tracing::warn!(vault_id = %vault_id, error = %e, "close-time flush failed; pending rows preserved");
    }
}

pub async fn get_pending_rewrites_count(
    state: &AppState,
    req: GetPendingRewritesCountRequest,
) -> Result<GetPendingRewritesCountResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let count = pending_count_total(vault.index()).await?;
    Ok(GetPendingRewritesCountResponse { count })
}

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

pub async fn undo_rename(
    state: &AppState,
    app: &dyn EventSink,
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

pub(super) async fn path_tracked(
    conn: &libsql::Connection,
    path: &str,
) -> Result<bool, CubicalError> {
    let mut rows = conn
        .query("SELECT 1 FROM files WHERE path = ?1", params![path])
        .await?;
    Ok(rows.next().await?.is_some())
}

async fn any_pending_named(
    conn: &libsql::Connection,
    old_basename: &str,
    old_path_no_md: &str,
) -> Result<bool, CubicalError> {
    let mut rows = conn
        .query(
            "SELECT 1 FROM pending_rewrites \
             WHERE rewrite_kind = 'wiki_link' \
             AND (LOWER(old_token) = LOWER(?1) OR LOWER(old_token) = LOWER(?2)) LIMIT 1",
            params![old_basename, old_path_no_md],
        )
        .await?;
    Ok(rows.next().await?.is_some())
}

async fn select_broken_referrers_naming(
    conn: &libsql::Connection,
    old_basename: &str,
    old_path_no_md: &str,
) -> Result<Vec<(String, String)>, CubicalError> {
    let mut rows = conn
        .query(
            "SELECT DISTINCT source_path, target_raw FROM links \
             WHERE target_path IS NULL \
             AND (LOWER(target_raw) = LOWER(?1) OR LOWER(target_raw) = LOWER(?2))",
            params![old_basename, old_path_no_md],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push((row.get(0)?, row.get(1)?));
    }
    Ok(out)
}

pub(super) async fn reconnect_broken_links_to(
    tx: &libsql::Transaction,
    to_path: &str,
    old_basename: &str,
    old_path_no_md: &str,
) -> Result<(), CubicalError> {
    tx.execute(
        "UPDATE links SET target_path = ?1 \
         WHERE target_path IS NULL \
         AND (LOWER(target_raw) = LOWER(?2) OR LOWER(target_raw) = LOWER(?3))",
        params![to_path, old_basename, old_path_no_md],
    )
    .await?;
    Ok(())
}

async fn prune_materialized_journal(vault: &cubical_core::Vault) {
    if let Err(e) = prune_materialized_journal_inner(vault).await {
        tracing::warn!(error = %e, "rename journal prune failed");
    }
}

async fn prune_materialized_journal_inner(vault: &cubical_core::Vault) -> Result<(), CubicalError> {
    let entries = cubical_core::vault::rename_journal::read_entries(vault.root());
    if entries.is_empty() {
        return Ok(());
    }
    let conn = vault.index().connection();
    let mut prune: HashSet<i64> = HashSet::new();
    for e in &entries {
        if e.kind != "file" {
            continue;
        }
        if path_tracked(conn, &e.from).await? {
            continue;
        }
        if !path_tracked(conn, &e.to).await? {
            prune.insert(e.op_id);
            continue;
        }
        let (old_basename, old_path_no_md) = link_name_forms(&e.from);
        if !any_pending_named(conn, &old_basename, &old_path_no_md).await? {
            prune.insert(e.op_id);
        }
    }
    if !prune.is_empty() {
        let _ = cubical_core::vault::rename_journal::rewrite_without(vault.root(), &prune);
    }
    Ok(())
}

pub async fn replay_rename_journal(
    vault: &cubical_core::Vault,
    app: &dyn EventSink,
    vault_id: &str,
) {
    if let Err(e) = replay_rename_journal_inner(vault, app, vault_id).await {
        tracing::warn!(vault_id = %vault_id, error = %e, "rename journal replay failed");
    }
}

async fn replay_rename_journal_inner(
    vault: &cubical_core::Vault,
    app: &dyn EventSink,
    vault_id: &str,
) -> Result<(), CubicalError> {
    let entries = cubical_core::vault::rename_journal::read_entries(vault.root());
    if entries.is_empty() {
        return Ok(());
    }
    let conn = vault.index().connection();
    let mut any_enqueued = false;

    for e in &entries {
        if e.kind != "file" {
            continue;
        }
        if path_tracked(conn, &e.from).await? || !path_tracked(conn, &e.to).await? {
            continue;
        }

        let (old_basename, old_path_no_md) = link_name_forms(&e.from);
        let referrers =
            select_broken_referrers_naming(conn, &old_basename, &old_path_no_md).await?;
        if referrers.is_empty() {
            continue;
        }

        let op = mint_rename_op_id(vault).await?;
        let now = unix_now_secs();
        let tx = conn.transaction().await?;
        reconnect_broken_links_to(&tx, &e.to, &old_basename, &old_path_no_md).await?;
        for (source_path, target_raw) in &referrers {
            let new_token = derive_wikilink_new_token(target_raw, &e.from, &e.to);
            enqueue_coalesced(
                &tx,
                source_path,
                "wiki_link",
                target_raw,
                &new_token,
                now,
                op,
            )
            .await?;
        }
        tx.commit().await?;
        any_enqueued = true;
    }

    prune_materialized_journal(vault).await;

    if any_enqueued {
        let count = pending_count_total(vault.index()).await?;
        emit_pending_rewrites_changed(
            app,
            VaultPendingRewritesChanged {
                vault_id: vault_id.to_string(),
                count,
            },
        );
    }
    Ok(())
}

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
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, vault, state)
    }

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

    #[tokio::test]
    async fn mint_rename_op_id_returns_monotonic_sequence_from_one() {
        let (_d, vault, _state) = fresh("v1").await;
        assert_eq!(mint_rename_op_id(&vault).await.unwrap(), 1);
        assert_eq!(mint_rename_op_id(&vault).await.unwrap(), 2);
        assert_eq!(mint_rename_op_id(&vault).await.unwrap(), 3);
    }

    #[test]
    fn wikilink_new_token_basename_form() {
        let got = derive_wikilink_new_token("Daily", "notes/Daily.md", "notes/Journal.md");
        assert_eq!(got, "Journal");
    }

    #[test]
    fn wikilink_new_token_path_form() {
        let got = derive_wikilink_new_token("notes/Daily", "notes/Daily.md", "archive/Journal.md");
        assert_eq!(got, "archive/Journal");
    }

    use crate::events::NoopEventSink;

    #[tokio::test]
    async fn rename_file_enqueues_one_row_per_distinct_referrer_pair() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        seed_file(&vault, "Project.md", "markdown").await;
        seed_file(&vault, "Notes.md", "markdown").await;
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
        std::fs::write(vault.root().join("Daily.md"), "body\n").unwrap();

        let resp = rename_file(
            &state,
            &NoopEventSink,
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
        let p = pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].old_token, "Daily");
        assert_eq!(p[0].new_token, "Journal");
        let n = pending_for_target(vault.index(), "Notes.md").await.unwrap();
        assert_eq!(n.len(), 1);
    }

    async fn seed_one_referrer_to_daily(vault: &Vault) {
        seed_file(vault, "Daily.md", "markdown").await;
        seed_file(vault, "Project.md", "markdown").await;
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
    }

    #[tokio::test]
    async fn rename_file_round_trip_cancels_pending_rows() {
        let (_d, vault, state) = fresh("v1").await;
        seed_one_referrer_to_daily(&vault).await;

        let r1 = rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(r1.pending_count, 1, "first rename enqueues one row");

        let r2 = rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Journal.md".into(),
                to_path: "Daily.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(
            r2.pending_count, 0,
            "renaming back to the original must cancel, not double",
        );
        assert!(
            pending_for_target(vault.index(), "Project.md")
                .await
                .unwrap()
                .is_empty(),
            "the referrer's pending row must be gone after the round trip",
        );
    }

    #[tokio::test]
    async fn rename_file_chained_coalesces_into_single_row() {
        let (_d, vault, state) = fresh("v1").await;
        seed_one_referrer_to_daily(&vault).await;

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");
        let r2 = rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Journal.md".into(),
                to_path: "Archive.md".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(r2.pending_count, 1, "chained renames coalesce to one row");
        let p = pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].old_token, "Daily", "old_token tracks the on-disk text");
        assert_eq!(p[0].new_token, "Archive", "new_token is the latest name");
    }

    #[tokio::test]
    async fn rename_file_keeps_search_index_in_sync() {
        use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        let body = "uniquetoken body\n";
        std::fs::write(vault.root().join("Daily.md"), body).unwrap();
        cubical_core::vault::search_refresh::refresh_search_index(
            &vault,
            "Daily.md",
            body,
            0,
            body.len() as u64,
        )
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
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

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
    async fn rename_reconnects_broken_links_by_raw_name_when_enabled() {
        use cubical_index::backlinks_for;
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "Broken.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Broken.md",
            &[LinkRow {
                target_raw: "a".into(),
                target_path: None,
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 4,
            }],
        )
        .await
        .unwrap();
        std::fs::write(vault.root().join("a.md"), "body\n").unwrap();
        std::fs::write(vault.root().join("Broken.md"), "see [[a]]\n").unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect("rename");

        let bl = backlinks_for(vault.index(), "b.md").await.unwrap();
        assert!(
            bl.iter().any(|r| r.source_path == "Broken.md"),
            "broken link reconnected as a backlink of b.md",
        );
        let p = pending_for_target(vault.index(), "Broken.md")
            .await
            .unwrap();
        assert_eq!(p.len(), 1, "a rewrite is queued for the reconnected link");
        assert_eq!(p[0].old_token, "a");
        assert_eq!(p[0].new_token, "b");
    }

    #[tokio::test]
    async fn rename_reconnects_broken_links_case_insensitively() {
        use cubical_index::backlinks_for;
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "Broken.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Broken.md",
            &[LinkRow {
                target_raw: "A".into(),
                target_path: None,
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 4,
            }],
        )
        .await
        .unwrap();
        std::fs::write(vault.root().join("a.md"), "body\n").unwrap();
        std::fs::write(vault.root().join("Broken.md"), "see [[A]]\n").unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect("rename");

        let bl = backlinks_for(vault.index(), "b.md").await.unwrap();
        assert!(
            bl.iter().any(|r| r.source_path == "Broken.md"),
            "case-variant broken link reconnected as a backlink of b.md",
        );
        let p = pending_for_target(vault.index(), "Broken.md")
            .await
            .unwrap();
        assert_eq!(p.len(), 1, "a rewrite is queued for the reconnected link");
        assert_eq!(p[0].old_token, "A");
    }

    #[tokio::test]
    async fn rename_file_appends_durability_journal() {
        use cubical_core::vault::rename_journal::read_entries;
        let (_d, vault, state) = fresh("v1").await;
        seed_one_referrer_to_daily(&vault).await;

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

        let entries = read_entries(vault.root());
        assert_eq!(entries.len(), 1, "the rename is journaled");
        assert_eq!(entries[0].from, "Daily.md");
        assert_eq!(entries[0].to, "Journal.md");
        assert_eq!(entries[0].kind, "file");
    }

    #[tokio::test]
    async fn replay_rename_journal_reconnects_after_index_wipe() {
        use cubical_core::vault::rename_journal::{append_entry, read_entries, RenameJournalEntry};
        use cubical_index::backlinks_for;
        let (_d, vault, state) = fresh("v1").await;
        let _ = &state;
        seed_file(&vault, "b.md", "markdown").await;
        seed_file(&vault, "Referrer.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Referrer.md",
            &[LinkRow {
                target_raw: "a".into(),
                target_path: None,
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 4,
            }],
        )
        .await
        .unwrap();
        append_entry(
            vault.root(),
            &RenameJournalEntry {
                op_id: 1,
                kind: "file".into(),
                from: "a.md".into(),
                to: "b.md".into(),
                at: 0,
            },
        )
        .unwrap();

        replay_rename_journal(&vault, &NoopEventSink, "v1").await;

        let bl = backlinks_for(vault.index(), "b.md").await.unwrap();
        assert!(
            bl.iter().any(|r| r.source_path == "Referrer.md"),
            "replay reconnects the stranded referrer to the moved file",
        );
        let p = pending_for_target(vault.index(), "Referrer.md")
            .await
            .unwrap();
        assert_eq!(p.len(), 1, "replay re-queues the deferred text rewrite");
        assert_eq!(p[0].old_token, "a");
        assert_eq!(p[0].new_token, "b");
        assert_eq!(
            read_entries(vault.root()).len(),
            1,
            "the journal entry survives until the rewrite is flushed",
        );
    }

    #[tokio::test]
    async fn flush_prunes_materialized_journal_entry() {
        use cubical_core::vault::rename_journal::read_entries;
        let (_d, vault, state) = fresh("v1").await;
        seed_one_referrer_to_daily(&vault).await;
        std::fs::write(vault.root().join("Project.md"), "see [[Daily]]\n").unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("rename");
        assert_eq!(
            read_entries(vault.root()).len(),
            1,
            "rename journals the op"
        );

        flush_pending_rewrites(
            &state,
            &NoopEventSink,
            FlushPendingRewritesRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("flush");

        assert!(
            read_entries(vault.root()).is_empty(),
            "journal entry pruned once its rewrite flushed",
        );
    }

    #[tokio::test]
    async fn rename_leaves_broken_links_when_disabled() {
        use cubical_index::backlinks_for;
        let (_d, vault, state) = fresh("v1").await;
        {
            let guard = state.vaults().read().await;
            let open = guard.get("v1").unwrap();
            open.settings.write().await.insert(
                "wikilinks.rewrite_broken_links_on_rename".into(),
                serde_json::json!(false),
            );
        }
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "Broken.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Broken.md",
            &[LinkRow {
                target_raw: "a".into(),
                target_path: None,
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 4,
            }],
        )
        .await
        .unwrap();
        std::fs::write(vault.root().join("a.md"), "body\n").unwrap();
        std::fs::write(vault.root().join("Broken.md"), "see [[a]]\n").unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect("rename");

        let bl = backlinks_for(vault.index(), "b.md").await.unwrap();
        assert!(
            !bl.iter().any(|r| r.source_path == "Broken.md"),
            "broken link must be left untouched when the setting is off",
        );
        assert!(pending_for_target(vault.index(), "Broken.md")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn chained_rename_keeps_backlinks_for_unflushed_referrer() {
        use cubical_index::backlinks_for;
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "Ref.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Ref.md",
            &[LinkRow {
                target_raw: "a".into(),
                target_path: Some("a.md".into()),
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 0,
            }],
        )
        .await
        .unwrap();
        std::fs::write(vault.root().join("a.md"), "body\n").unwrap();
        std::fs::write(vault.root().join("Ref.md"), "see [[a]]\n").unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect("a→b");
        let bl_b = backlinks_for(vault.index(), "b.md").await.unwrap();
        assert_eq!(
            bl_b.iter()
                .map(|r| r.source_path.as_str())
                .collect::<Vec<_>>(),
            vec!["Ref.md"],
            "after a→b, Ref.md must be a backlink of b.md",
        );

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "b.md".into(),
                to_path: "c.md".into(),
            },
        )
        .await
        .expect("b→c");
        let bl_c = backlinks_for(vault.index(), "c.md").await.unwrap();
        assert_eq!(
            bl_c.iter()
                .map(|r| r.source_path.as_str())
                .collect::<Vec<_>>(),
            vec!["Ref.md"],
            "after b→c, Ref.md must STILL be a backlink (of c.md)",
        );
        let p = pending_for_target(vault.index(), "Ref.md").await.unwrap();
        assert_eq!(p.len(), 1, "one coalesced pending row, not two");
        assert_eq!(p[0].old_token, "a");
        assert_eq!(p[0].new_token, "c");
    }

    #[tokio::test]
    async fn chained_rename_keeps_backlinks_for_referrer_flushed_to_intermediate() {
        use cubical_index::backlinks_for;
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "Ref.md", "markdown").await;
        replace_links_for_file(
            vault.index(),
            "Ref.md",
            &[LinkRow {
                target_raw: "a".into(),
                target_path: Some("a.md".into()),
                anchor_kind: None,
                anchor_value: None,
                display_text: None,
                is_embed: false,
                position: 4,
            }],
        )
        .await
        .unwrap();
        std::fs::write(vault.root().join("a.md"), "body\n").unwrap();
        std::fs::write(vault.root().join("Ref.md"), "see [[a]]\n").unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "a.md".into(),
                to_path: "b.md".into(),
            },
        )
        .await
        .expect("a→b");

        flush_pending_for_target(&vault, "Ref.md", None)
            .await
            .expect("flush");
        assert_eq!(
            std::fs::read_to_string(vault.root().join("Ref.md")).unwrap(),
            "see [[b]]\n",
            "after flush, Ref.md on disk points at [[b]]",
        );
        let src = std::fs::read_to_string(vault.root().join("Ref.md")).unwrap();
        cubical_core::refresh_links(&vault, "Ref.md", &src)
            .await
            .unwrap();

        rename_file(
            &state,
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "b.md".into(),
                to_path: "c.md".into(),
            },
        )
        .await
        .expect("b→c");

        let bl_c = backlinks_for(vault.index(), "c.md").await.unwrap();
        assert_eq!(
            bl_c.iter()
                .map(|r| r.source_path.as_str())
                .collect::<Vec<_>>(),
            vec!["Ref.md"],
            "after flush-then-b→c, Ref.md must still be a backlink of c.md",
        );
        let on_disk = std::fs::read_to_string(vault.root().join("Ref.md")).unwrap();
        let materialized =
            cubical_core::vault::pending::materialize_on_read(vault.index(), "Ref.md", &on_disk)
                .await
                .unwrap();
        assert_eq!(
            materialized, "see [[c]]\n",
            "opening Ref.md must show [[c]], not the stale [[b]]",
        );
    }

    #[tokio::test]
    async fn rename_file_explicit_rekeys_fk_tables_to_new_path() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Daily.md", "markdown").await;
        std::fs::write(
            vault.root().join("Daily.md"),
            "#planning body\n\nsomething ^intro\n",
        )
        .unwrap();
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
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

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

        assert!(block_exists(vault.index(), "Journal.md", "intro")
            .await
            .unwrap());
        assert!(!block_exists(vault.index(), "Daily.md", "intro")
            .await
            .unwrap());

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
            &NoopEventSink,
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
            &NoopEventSink,
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
            &NoopEventSink,
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
            &NoopEventSink,
            RenameFileRequest {
                vault_id: "v1".into(),
                from_path: "Daily.md".into(),
                to_path: "Journal.md".into(),
            },
        )
        .await
        .expect("ok");

        let rows = backlinks_for(vault.index(), "Journal.md").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_path, "Project.md");
    }

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
            &NoopEventSink,
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
            &NoopEventSink,
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

    #[tokio::test]
    async fn rename_block_id_enqueues_referrers_plus_defining_file() {
        let (_d, vault, state) = fresh("v1").await;
        seed_file(&vault, "Pinned.md", "markdown").await;
        seed_file(&vault, "Refs.md", "markdown").await;
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
            &NoopEventSink,
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
        let err = rename_block_id(
            &state,
            &NoopEventSink,
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
            &NoopEventSink,
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

        let written = std::fs::read(vault.root().join("Project.md")).unwrap();
        let expected_hash = sha256_bytes_hex(&written);
        let entries = gate.lock().await;
        assert!(
            entries.contains(&("Project.md".to_string(), expected_hash)),
            "gate must contain the post-write hash entry",
        );
    }

    #[tokio::test]
    async fn flush_silently_drops_rows_for_externally_deleted_target_file() {
        let (_d, vault, _state) = fresh("v1").await;
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
            &NoopEventSink,
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
            &NoopEventSink,
            UndoRenameRequest {
                vault_id: "v1".into(),
                rename_op_id: 1,
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.removed, 1);
        assert_eq!(resp.pending_count, 1);

        let n = pending_count_for_target(vault.index(), "B.md")
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn fifty_per_file_fuse_flushes_only_the_offending_target() {
        let (_d, vault, _state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "[[X]] [[X]] [[X]]\n").unwrap();
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
        let resp = flush_all_for_vault(&vault, &gate, &guard, &NoopEventSink, "v1")
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
            std::sync::Arc::new(NoopEventSink),
            vault.clone(),
            gate.clone(),
            guard.clone(),
            "v1".into(),
            cancel.clone(),
        );

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
