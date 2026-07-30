use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tokio::sync::{mpsc, Mutex, RwLock};

use cubical_core::vault::links::read_source_off_executor;
use cubical_core::vault::pending::materialize_on_read;
use cubical_core::vault::settings::SettingsMap;
use cubical_core::{
    refresh_block_refs_for_file, refresh_blocks, refresh_frontmatter, refresh_links, refresh_tags,
    scan, ScanProgress, Vault, VaultError, WatchEvent,
};
use libsql::params;
use tokio_util::sync::CancellationToken;

use crate::state::{OpenVault, ScanStatusBackend};

pub type FlushOwnWrites = Arc<Mutex<HashSet<(PathBuf, String)>>>;

pub const VAULT_SCAN_PROGRESS: &str = "vault:scan-progress";

pub const VAULT_SCAN_COMPLETE: &str = "vault:scan-complete";

pub const VAULT_SCAN_CANCELLED: &str = "vault:scan-cancelled";

pub const VAULT_FILE_CHANGED: &str = "vault:file-changed";

pub const VAULT_PENDING_REWRITES_CHANGED: &str = "vault:pending-rewrites-changed";

pub const VAULT_FLUSH_COMPLETE: &str = "vault:flush-complete";

pub const VAULT_AUDIT: &str = "vault:audit";

pub const VAULT_SETTING_CHANGED: &str = "vault:setting-changed";

#[derive(Serialize, Clone)]
pub struct VaultScanProgress {
    pub vault_id: String,
    pub files_processed: u32,
    pub files_total_estimate: u32,
}

#[derive(Serialize, Clone)]
pub struct VaultScanComplete {
    pub vault_id: String,
    pub file_count: u32,
    pub duration_ms: u64,
}

#[derive(Serialize, Clone)]
pub struct VaultScanCancelled {
    pub vault_id: String,
}

#[derive(Serialize, Clone)]
pub struct VaultFileChanged {
    pub vault_id: String,
    pub path: String,
    pub kind: VaultFileChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_content_hash: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum VaultFileChangeKind {
    Created,
    Modified,
    Removed,
    Renamed,
}

#[derive(Serialize, Clone)]
pub struct VaultAudit {
    pub level: String,
    pub category: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct VaultPendingRewritesChanged {
    pub vault_id: String,
    pub count: i64,
}

#[derive(Serialize, Clone)]
pub struct VaultSettingChanged {
    pub vault_id: String,
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Serialize, Clone)]
pub struct VaultFlushComplete {
    pub vault_id: String,
    pub files_rewritten: i64,
    pub refs_updated: i64,
}

#[derive(Clone)]
pub enum AppEvent {
    ScanProgress(VaultScanProgress),
    ScanComplete(VaultScanComplete),
    ScanCancelled(VaultScanCancelled),
    FileChanged(VaultFileChanged),
    Audit(VaultAudit),
    PendingRewritesChanged(VaultPendingRewritesChanged),
    FlushComplete(VaultFlushComplete),
    SettingChanged(VaultSettingChanged),
}

impl AppEvent {
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            AppEvent::ScanProgress(_) => VAULT_SCAN_PROGRESS,
            AppEvent::ScanComplete(_) => VAULT_SCAN_COMPLETE,
            AppEvent::ScanCancelled(_) => VAULT_SCAN_CANCELLED,
            AppEvent::FileChanged(_) => VAULT_FILE_CHANGED,
            AppEvent::Audit(_) => VAULT_AUDIT,
            AppEvent::PendingRewritesChanged(_) => VAULT_PENDING_REWRITES_CHANGED,
            AppEvent::FlushComplete(_) => VAULT_FLUSH_COMPLETE,
            AppEvent::SettingChanged(_) => VAULT_SETTING_CHANGED,
        }
    }
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: AppEvent);
}

pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit(&self, _event: AppEvent) {}
}

pub fn emit_scan_progress(sink: &dyn EventSink, payload: VaultScanProgress) {
    sink.emit(AppEvent::ScanProgress(payload));
}

pub fn emit_scan_complete(sink: &dyn EventSink, payload: VaultScanComplete) {
    sink.emit(AppEvent::ScanComplete(payload));
}

pub fn emit_scan_cancelled(sink: &dyn EventSink, payload: VaultScanCancelled) {
    sink.emit(AppEvent::ScanCancelled(payload));
}

pub fn emit_file_changed(sink: &dyn EventSink, payload: VaultFileChanged) {
    sink.emit(AppEvent::FileChanged(payload));
}

pub fn emit_audit(sink: &dyn EventSink, payload: VaultAudit) {
    sink.emit(AppEvent::Audit(payload));
}

pub fn emit_pending_rewrites_changed(sink: &dyn EventSink, payload: VaultPendingRewritesChanged) {
    sink.emit(AppEvent::PendingRewritesChanged(payload));
}

pub fn emit_flush_complete(sink: &dyn EventSink, payload: VaultFlushComplete) {
    sink.emit(AppEvent::FlushComplete(payload));
}

pub fn emit_setting_changed(sink: &dyn EventSink, payload: VaultSettingChanged) {
    sink.emit(AppEvent::SettingChanged(payload));
}

pub fn spawn_scan_dispatcher(
    sink: Arc<dyn EventSink>,
    state: Arc<RwLock<std::collections::HashMap<String, OpenVault>>>,
    vault_id: String,
    vault: Vault,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        let started = Instant::now();
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
        let scan_handle = tokio::spawn(scan(vault.clone(), cancel.clone(), tx));

        let vid_for_progress = vault_id.clone();
        let sink_for_progress = Arc::clone(&sink);
        let progress_pump = tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                emit_scan_progress(
                    sink_for_progress.as_ref(),
                    VaultScanProgress {
                        vault_id: vid_for_progress.clone(),
                        files_processed: p.files_processed,
                        files_total_estimate: p.files_total_estimate,
                    },
                );
            }
        });

        let scan_outcome = scan_handle.await;
        let _ = progress_pump.await;

        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let (new_status, new_search_state) = match scan_outcome {
            Ok(Ok(file_count)) => {
                crate::commands::rename::replay_rename_journal(&vault, sink.as_ref(), &vault_id)
                    .await;
                emit_scan_complete(
                    sink.as_ref(),
                    VaultScanComplete {
                        vault_id: vault_id.clone(),
                        file_count,
                        duration_ms: elapsed_ms,
                    },
                );
                (
                    ScanStatusBackend::Complete,
                    cubical_search::IndexState::Ready,
                )
            }
            Ok(Err(VaultError::ScanCancelled)) => {
                emit_scan_cancelled(
                    sink.as_ref(),
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                (
                    ScanStatusBackend::Cancelled,
                    cubical_search::IndexState::Error,
                )
            }
            Ok(Err(e)) => {
                tracing::error!(error = %e, vault_id = %vault_id, "scan failed");
                emit_scan_cancelled(
                    sink.as_ref(),
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                (
                    ScanStatusBackend::Cancelled,
                    cubical_search::IndexState::Error,
                )
            }
            Err(join_err) => {
                tracing::error!(error = %join_err, vault_id = %vault_id, "scan task join failed");
                emit_scan_cancelled(
                    sink.as_ref(),
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                (
                    ScanStatusBackend::Cancelled,
                    cubical_search::IndexState::Error,
                )
            }
        };

        let mut guard = state.write().await;
        if let Some(open) = guard.get_mut(&vault_id) {
            open.scan_status = new_status;
            if let Ok(mut cell) = open.search_state.lock() {
                cell.state = new_search_state;
            }
        }
    });
}

pub(crate) struct WatchContext<'a> {
    pub sink: &'a dyn EventSink,
    pub vault_id: &'a str,
    pub flush_own_writes: &'a FlushOwnWrites,
    pub settings: &'a RwLock<SettingsMap>,
}

pub fn spawn_watcher_dispatcher(
    sink: Arc<dyn EventSink>,
    vault_id: String,
    vault: Vault,
    mut events_rx: tokio::sync::mpsc::Receiver<WatchEvent>,
    flush_own_writes: FlushOwnWrites,
    settings: Arc<RwLock<SettingsMap>>,
) {
    tokio::spawn(async move {
        while let Some(first) = events_rx.recv().await {
            let mut batch = vec![first];
            while let Ok(next) = events_rx.try_recv() {
                batch.push(next);
            }
            let ctx = WatchContext {
                sink: sink.as_ref(),
                vault_id: &vault_id,
                flush_own_writes: &flush_own_writes,
                settings: settings.as_ref(),
            };
            handle_watch_batch(&vault, batch, &ctx).await;
        }
        tracing::debug!(vault_id = %vault_id, "watcher dispatcher: channel closed");
    });
}

async fn handle_watch_batch(vault: &Vault, batch: Vec<WatchEvent>, ctx: &WatchContext<'_>) {
    let arrived = Instant::now();
    let sink = ctx.sink;
    let vault_id = ctx.vault_id;
    let flush_own_writes = ctx.flush_own_writes;

    let hashes = apply_watch_events_batch(vault, &batch, Some(ctx)).await;

    for (ev, new_content_hash) in batch.iter().zip(hashes) {
        if consume_own_write_hash(flush_own_writes, ev, new_content_hash.as_deref()).await {
            tracing::debug!(
                vault_id = %vault_id,
                "watcher: suppressing vault:file-changed for own-write",
            );
            continue;
        }
        let payload = file_changed_payload(vault_id, ev, new_content_hash);
        tracing::info!(
            vault_id = %vault_id,
            kind = ?payload.kind,
            path = %payload.path,
            elapsed_ms = arrived.elapsed().as_millis(),
            "watcher: emitting vault:file-changed",
        );
        emit_file_changed(sink, payload);
    }
}

pub(crate) async fn apply_watch_event_to_db(
    vault: &Vault,
    ev: &WatchEvent,
    ctx: Option<&WatchContext<'_>>,
) -> Option<String> {
    let now = unix_now_secs();
    let conn = vault.index().connection();

    if let WatchEvent::Created(rel) | WatchEvent::Modified(rel) = ev {
        if vault.root().join(rel).is_dir() {
            let path_str = rel.to_string_lossy().into_owned();
            if let Err(e) = cubical_index::upsert_folder(vault.index(), &path_str, now).await {
                tracing::warn!(path = %path_str, error = %e, "watcher: folder upsert failed");
            }
            let (message, detail) = audit_payload_for(ev);
            if let Err(e) = conn
                .execute(
                    "INSERT INTO audit_log (timestamp, level, category, message, detail)
                     VALUES (?1, 'info', 'watcher', ?2, ?3)",
                    params![now, message, detail],
                )
                .await
            {
                tracing::warn!(error = %e, "watcher: folder audit_log insert failed");
            }
            return None;
        }
    }

    let new_content_hash = match ev {
        WatchEvent::Created(rel) | WatchEvent::Modified(rel) => {
            let abs = vault.root().join(rel);
            let path_str = rel.to_string_lossy().into_owned();
            let FileStats {
                size,
                mtime,
                hash,
                inode,
            } = read_file_stats(&abs, vault).await.unwrap_or_default();
            let type_id = vault
                .registry()
                .handler_for(&abs)
                .map(|h| h.type_id().to_string())
                .unwrap_or_else(|| "binary".into());

            let upsert = "
                INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
                ON CONFLICT(path) DO UPDATE SET
                    size_bytes   = excluded.size_bytes,
                    mtime_unix   = excluded.mtime_unix,
                    content_hash = excluded.content_hash,
                    inode        = excluded.inode,
                    last_seen    = excluded.last_seen,
                    updated_at   = excluded.last_seen
            ";
            if let Err(e) = conn
                .execute(
                    upsert,
                    params![
                        path_str.clone(),
                        type_id.clone(),
                        size,
                        mtime,
                        hash.clone(),
                        inode,
                        now
                    ],
                )
                .await
            {
                tracing::warn!(path = %path_str, error = %e, "watcher: files upsert failed");
            }

            if type_id == "markdown" {
                let raw_source = read_source_off_executor(&abs).await.unwrap_or_default();
                let source = match materialize_on_read(vault.index(), &path_str, &raw_source).await
                {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(path = %path_str, error = %e, "watcher: materialize_on_read failed; using raw source");
                        raw_source
                    }
                };

                if let Err(e) = refresh_frontmatter(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: frontmatter refresh failed");
                }
                if let Err(e) = refresh_links(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: links refresh failed");
                }
                if let Err(e) = refresh_tags(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: tags refresh failed");
                }
                if let Err(e) = refresh_blocks(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: blocks refresh failed");
                }
                if let Err(e) = refresh_block_refs_for_file(vault, &path_str).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: block_refs refresh failed");
                }
                let search_size_bytes = source.len() as u64;
                if let Err(e) = cubical_core::vault::search_refresh::refresh_search_index(
                    vault,
                    &path_str,
                    &source,
                    mtime,
                    search_size_bytes,
                )
                .await
                {
                    tracing::warn!(path = %path_str, error = %e, "watcher: search refresh failed");
                }
            }

            if hash.is_empty() {
                None
            } else {
                Some(hash)
            }
        }
        WatchEvent::Removed(rel) => {
            let path_str = rel.to_string_lossy().into_owned();
            if let Err(e) = conn
                .execute(
                    "DELETE FROM files WHERE path = ?1",
                    params![path_str.clone()],
                )
                .await
            {
                tracing::warn!(path = %path_str, error = %e, "watcher: files row delete failed");
            }
            if let Err(e) = cubical_index::delete_folder(vault.index(), &path_str).await {
                tracing::warn!(path = %path_str, error = %e, "watcher: folder row delete failed");
            }
            if let Err(e) =
                cubical_core::vault::search_refresh::delete_search_index(vault, &path_str).await
            {
                tracing::warn!(path = %path_str, error = %e, "watcher: search delete failed");
            }
            None
        }
        WatchEvent::Renamed { from, to } => {
            let from_str = from.to_string_lossy().into_owned();
            let to_str = to.to_string_lossy().into_owned();

            if try_adopt_external_rename(vault, ctx, &from_str, &to_str).await {
                if let Err(e) = conn
                    .execute(
                        "UPDATE files SET last_seen = ?1, updated_at = ?1 WHERE path = ?2",
                        params![now, to_str.clone()],
                    )
                    .await
                {
                    tracing::warn!(path = %to_str, error = %e, "watcher: adopted rename last_seen update failed");
                }
            } else {
                if let Err(e) = conn
                    .execute(
                        "UPDATE files SET last_seen = ?1 WHERE path = ?2",
                        params![now, from_str.clone()],
                    )
                    .await
                {
                    tracing::warn!(path = %from_str, error = %e, "watcher: rename last_seen update failed");
                }
                if let Err(e) =
                    cubical_core::vault::search_refresh::delete_search_index(vault, &from_str).await
                {
                    tracing::warn!(path = %from_str, error = %e, "watcher: search delete (rename old) failed");
                }
            }
            None
        }
    };

    let (message, detail) = audit_payload_for(ev);
    if let Err(e) = conn
        .execute(
            "INSERT INTO audit_log (timestamp, level, category, message, detail)
             VALUES (?1, 'info', 'watcher', ?2, ?3)",
            params![now, message, detail],
        )
        .await
    {
        tracing::warn!(error = %e, "watcher: audit_log insert failed");
    }

    new_content_hash
}

async fn try_adopt_external_rename(
    vault: &Vault,
    ctx: Option<&WatchContext<'_>>,
    from: &str,
    to: &str,
) -> bool {
    let Some(ctx) = ctx else {
        return false;
    };
    let rewrite_broken = ctx
        .settings
        .read()
        .await
        .get(crate::commands::rename::WIKILINKS_REWRITE_BROKEN_KEY)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);

    match crate::commands::rename::adopt_external_rename(
        ctx.sink,
        crate::commands::rename::AdoptExternalRenameInput {
            vault,
            flush_own_writes: ctx.flush_own_writes,
            vault_id: ctx.vault_id,
            from_path: from,
            to_path: to,
            rewrite_broken,
        },
    )
    .await
    {
        Ok(adopted) => adopted,
        Err(e) => {
            tracing::warn!(
                from = %from,
                to = %to,
                error = %e,
                "watcher: external rename adoption failed; leaving the old path to degrade",
            );
            false
        }
    }
}

pub(crate) async fn apply_watch_events_batch(
    vault: &Vault,
    events: &[WatchEvent],
    ctx: Option<&WatchContext<'_>>,
) -> Vec<Option<String>> {
    let mut hashes = Vec::with_capacity(events.len());
    for ev in events {
        hashes.push(apply_watch_event_to_db(vault, ev, ctx).await);
    }
    if let Err(e) = vault.search().commit() {
        tracing::warn!(error = %e, "watcher: batch search commit failed");
    }
    if let Err(e) =
        cubical_index::prune_audit_log(vault.index(), cubical_index::AUDIT_LOG_MAX_ROWS).await
    {
        tracing::warn!(error = %e, "watcher: audit_log prune failed");
    }
    hashes
}

#[derive(Default)]
struct FileStats {
    size: i64,
    mtime: i64,
    hash: String,
    inode: Option<i64>,
}

#[cfg(unix)]
fn inode_of(metadata: &std::fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    Some(i64::try_from(metadata.ino()).unwrap_or(i64::MAX))
}

#[cfg(not(unix))]
fn inode_of(_metadata: &std::fs::Metadata) -> Option<i64> {
    None
}

async fn read_file_stats(abs: &std::path::Path, vault: &Vault) -> Option<FileStats> {
    let metadata = match std::fs::metadata(abs) {
        Ok(m) => m,
        Err(e) => {
            tracing::debug!(path = %abs.display(), error = %e, "watcher: metadata read failed");
            return None;
        }
    };
    let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    let inode = inode_of(&metadata);

    let abs_for_hash = abs.to_path_buf();
    let registry = vault.registry_arc();
    let hash = tokio::task::spawn_blocking(move || {
        registry
            .handler_for(&abs_for_hash)
            .ok_or_else(|| "no handler".to_string())
            .and_then(|h| h.content_hash(&abs_for_hash).map_err(|e| e.to_string()))
    })
    .await;
    let hash = match hash {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            tracing::debug!(path = %abs.display(), error = %e, "watcher: hash failed");
            return None;
        }
        Err(e) => {
            tracing::warn!(path = %abs.display(), error = %e, "watcher: hash join failed");
            return None;
        }
    };
    Some(FileStats {
        size,
        mtime,
        hash,
        inode,
    })
}

fn audit_payload_for(ev: &WatchEvent) -> (String, String) {
    match ev {
        WatchEvent::Created(p) => (
            format!("created {}", p.display()),
            serde_json::json!({ "kind": "created", "path": p.to_string_lossy() }).to_string(),
        ),
        WatchEvent::Modified(p) => (
            format!("modified {}", p.display()),
            serde_json::json!({ "kind": "modified", "path": p.to_string_lossy() }).to_string(),
        ),
        WatchEvent::Removed(p) => (
            format!("removed {}", p.display()),
            serde_json::json!({ "kind": "removed", "path": p.to_string_lossy() }).to_string(),
        ),
        WatchEvent::Renamed { from, to } => (
            format!("renamed {} → {}", from.display(), to.display()),
            serde_json::json!({
                "kind": "renamed",
                "from": from.to_string_lossy(),
                "to": to.to_string_lossy(),
            })
            .to_string(),
        ),
    }
}

pub(crate) async fn consume_own_write_hash(
    flush_own_writes: &FlushOwnWrites,
    ev: &WatchEvent,
    new_content_hash: Option<&str>,
) -> bool {
    let WatchEvent::Modified(rel) = ev else {
        return false;
    };
    let Some(hash) = new_content_hash else {
        return false;
    };
    if hash.is_empty() {
        return false;
    }
    let key = (rel.clone(), hash.to_string());
    flush_own_writes.lock().await.remove(&key)
}

fn file_changed_payload(
    vault_id: &str,
    ev: &WatchEvent,
    new_content_hash: Option<String>,
) -> VaultFileChanged {
    match ev {
        WatchEvent::Created(p) => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: p.to_string_lossy().into_owned(),
            kind: VaultFileChangeKind::Created,
            from_path: None,
            new_content_hash,
        },
        WatchEvent::Modified(p) => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: p.to_string_lossy().into_owned(),
            kind: VaultFileChangeKind::Modified,
            from_path: None,
            new_content_hash,
        },
        WatchEvent::Removed(p) => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: p.to_string_lossy().into_owned(),
            kind: VaultFileChangeKind::Removed,
            from_path: None,
            new_content_hash: None,
        },
        WatchEvent::Renamed { from, to } => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: to.to_string_lossy().into_owned(),
            kind: VaultFileChangeKind::Renamed,
            from_path: Some(from.to_string_lossy().into_owned()),
            new_content_hash: None,
        },
    }
}

fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {

    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    async fn fresh_vault_with_one_md(name: &str) -> (tempfile::TempDir, Vault) {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(name), b"hello\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");
        (dir, vault)
    }

    #[tokio::test]
    async fn created_event_writes_files_row_and_audit_log() {
        let (_dir, vault) = fresh_vault_with_one_md("note.md").await;

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md")), None)
                .await;
        assert!(hash.is_some(), "Created on a real file returns its hash");

        let conn = vault.index().connection();
        let mut rows = conn
            .query(
                "SELECT type_id, content_hash FROM files WHERE path = 'note.md'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("files row");
        let type_id: String = row.get(0).unwrap();
        let hash: String = row.get(1).unwrap();
        assert_eq!(type_id, "markdown");
        assert!(!hash.is_empty(), "content_hash must be set");

        let mut rows = conn
            .query(
                "SELECT category, level, message, detail
                 FROM audit_log
                 ORDER BY id DESC LIMIT 1",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("audit_log row");
        let category: String = row.get(0).unwrap();
        let level: String = row.get(1).unwrap();
        let message: String = row.get(2).unwrap();
        let detail: String = row.get(3).unwrap();
        assert_eq!(category, "watcher");
        assert_eq!(level, "info");
        assert!(message.contains("created"), "{message}");
        assert!(message.contains("note.md"), "{message}");
        let parsed: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(parsed["kind"], "created");
        assert_eq!(parsed["path"], "note.md");
    }

    #[cfg(unix)]
    async fn read_inode_column(vault: &Vault, path: &str) -> Option<i64> {
        let conn = vault.index().connection();
        let mut rows = conn
            .query("SELECT inode FROM files WHERE path = ?1", params![path])
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("files row");
        row.get(0).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn created_event_records_the_real_inode() {
        use std::os::unix::fs::MetadataExt;

        let (dir, vault) = fresh_vault_with_one_md("note.md").await;
        let fresh = dir.path().join("fresh.md");
        std::fs::write(&fresh, "body\n").unwrap();

        apply_watch_event_to_db(
            &vault,
            &WatchEvent::Created(PathBuf::from("fresh.md")),
            None,
        )
        .await;

        let expected = i64::try_from(std::fs::metadata(&fresh).unwrap().ino()).unwrap();
        assert_eq!(
            read_inode_column(&vault, "fresh.md").await,
            Some(expected),
            "Created must record the inode the file actually has on disk"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn modified_event_refreshes_the_inode_after_replacement() {
        use std::os::unix::fs::MetadataExt;

        let (dir, vault) = fresh_vault_with_one_md("note.md").await;
        let note = dir.path().join("note.md");

        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md")), None).await;
        let first = read_inode_column(&vault, "note.md")
            .await
            .expect("inode set");

        let swap = dir.path().join("swap.tmp");
        std::fs::write(&swap, "replaced\n").unwrap();
        std::fs::rename(&swap, &note).unwrap();
        let replaced = i64::try_from(std::fs::metadata(&note).unwrap().ino()).unwrap();
        assert_ne!(first, replaced, "replacement must change the inode");

        apply_watch_event_to_db(
            &vault,
            &WatchEvent::Modified(PathBuf::from("note.md")),
            None,
        )
        .await;

        assert_eq!(
            read_inode_column(&vault, "note.md").await,
            Some(replaced),
            "ON CONFLICT must refresh inode, not keep the stale one"
        );
    }

    #[tokio::test]
    async fn created_event_on_missing_file_leaves_inode_null() {
        let (_dir, vault) = fresh_vault_with_one_md("note.md").await;

        apply_watch_event_to_db(
            &vault,
            &WatchEvent::Created(PathBuf::from("ghost.md")),
            None,
        )
        .await;

        let conn = vault.index().connection();
        let mut rows = conn
            .query("SELECT inode FROM files WHERE path = 'ghost.md'", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("files row");
        let inode: Option<i64> = row.get(0).unwrap();
        assert_eq!(
            inode, None,
            "a NULL inode stays legal when stats are absent"
        );
    }

    #[tokio::test]
    async fn modified_event_refreshes_frontmatter_table() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: Old\n---\n\nbody\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        let h1 =
            apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md")), None)
                .await
                .expect("Created hash");
        std::fs::write(&p, "---\ntitle: New\nstatus: ready\n---\n\nbody\n").unwrap();
        let h2 = apply_watch_event_to_db(
            &vault,
            &WatchEvent::Modified(PathBuf::from("note.md")),
            None,
        )
        .await
        .expect("Modified hash");
        assert_ne!(h1, h2, "hash must change after content changes");

        let conn = vault.index().connection();
        let mut rows = conn
            .query(
                "SELECT key, value FROM frontmatter WHERE file_path = 'note.md' ORDER BY key",
                (),
            )
            .await
            .unwrap();
        let mut got: Vec<(String, String)> = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            got.push((row.get(0).unwrap(), row.get(1).unwrap()));
        }
        assert_eq!(got.len(), 2, "expected exactly two keys after Modified");
        let map: std::collections::HashMap<String, String> = got.into_iter().collect();
        assert_eq!(map["title"], "\"New\"");
        assert_eq!(map["status"], "\"ready\"");
    }

    #[tokio::test]
    async fn modified_event_materializes_pending_for_extractors_but_hashes_raw_bytes() {
        use cubical_core::sha256_bytes_hex;
        use cubical_index::{enqueue_pending, links_from, NewPendingRewrite, RewriteKind};

        let dir = tempdir().unwrap();
        let p = dir.path().join("a.md");
        let raw = "linked to [[OldName]]\n";
        std::fs::write(&p, raw).unwrap();
        std::fs::write(dir.path().join("Daily.md"), "body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("a.md")), None).await;
        apply_watch_event_to_db(
            &vault,
            &WatchEvent::Created(PathBuf::from("Daily.md")),
            None,
        )
        .await;

        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "a.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "OldName".into(),
                new_token: "Daily".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Modified(PathBuf::from("a.md")), None)
                .await
                .expect("Modified hash");

        let rows = links_from(vault.index(), "a.md").await.expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_raw, "Daily");
        assert_eq!(rows[0].target_path.as_deref(), Some("Daily.md"));

        assert_eq!(hash, sha256_bytes_hex(raw.as_bytes()));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), raw);
    }

    #[tokio::test]
    async fn created_dir_event_records_folder_and_skips_files_table() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("projects")).unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        let hash = apply_watch_event_to_db(
            &vault,
            &WatchEvent::Created(PathBuf::from("projects")),
            None,
        )
        .await;
        assert!(hash.is_none(), "a directory carries no content hash");

        let folders = cubical_index::list_folders(vault.index()).await.unwrap();
        assert_eq!(folders, vec!["projects"], "dir recorded in folders");

        let conn = vault.index().connection();
        let mut rows = conn
            .query("SELECT COUNT(*) FROM files WHERE path = 'projects'", ())
            .await
            .unwrap();
        let n: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(n, 0, "a directory must not leak into the files table");
    }

    #[tokio::test]
    async fn removed_event_deletes_matching_folder_row() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("projects")).unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");
        apply_watch_event_to_db(
            &vault,
            &WatchEvent::Created(PathBuf::from("projects")),
            None,
        )
        .await;
        assert_eq!(
            cubical_index::list_folders(vault.index())
                .await
                .unwrap()
                .len(),
            1,
        );

        std::fs::remove_dir(dir.path().join("projects")).unwrap();
        apply_watch_event_to_db(
            &vault,
            &WatchEvent::Removed(PathBuf::from("projects")),
            None,
        )
        .await;
        assert!(
            cubical_index::list_folders(vault.index())
                .await
                .unwrap()
                .is_empty(),
            "Removed must drop the folder row",
        );
    }

    #[tokio::test]
    async fn renamed_event_audits_with_from_and_to() {
        let (_dir, vault) = fresh_vault_with_one_md("a.md").await;

        let hash = apply_watch_event_to_db(
            &vault,
            &WatchEvent::Renamed {
                from: PathBuf::from("a.md"),
                to: PathBuf::from("b.md"),
            },
            None,
        )
        .await;
        assert!(hash.is_none(), "Renamed must not carry a hash");

        let conn = vault.index().connection();
        let mut rows = conn
            .query(
                "SELECT message, detail FROM audit_log ORDER BY id DESC LIMIT 1",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("audit_log row");
        let message: String = row.get(0).unwrap();
        let detail: String = row.get(1).unwrap();
        assert!(message.contains("a.md"), "{message}");
        assert!(message.contains("b.md"), "{message}");
        let parsed: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(parsed["kind"], "renamed");
        assert_eq!(parsed["from"], "a.md");
        assert_eq!(parsed["to"], "b.md");
    }

    #[tokio::test]
    async fn removed_event_returns_no_hash() {
        let (_dir, vault) = fresh_vault_with_one_md("note.md").await;
        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md")), None).await;

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Removed(PathBuf::from("note.md")), None)
                .await;
        assert!(hash.is_none(), "Removed must not carry a hash");
    }

    #[tokio::test]
    async fn removed_event_deletes_files_row_and_cascades_children() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: Hi\n---\n\n#planning body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md")), None).await;
        let conn = vault.index().connection();
        let count = |sql: &'static str| {
            let conn = conn.clone();
            async move {
                let mut rows = conn.query(sql, ()).await.unwrap();
                let row = rows.next().await.unwrap().expect("count row");
                row.get::<i64>(0).unwrap()
            }
        };
        assert_eq!(
            count("SELECT COUNT(*) FROM files WHERE path='note.md'").await,
            1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM frontmatter WHERE file_path='note.md'").await,
            1,
            "Created should have seeded a frontmatter row",
        );

        std::fs::remove_file(&p).unwrap();
        apply_watch_event_to_db(&vault, &WatchEvent::Removed(PathBuf::from("note.md")), None).await;

        assert_eq!(
            count("SELECT COUNT(*) FROM files WHERE path='note.md'").await,
            0,
            "Removed must delete the files row",
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM frontmatter WHERE file_path='note.md'").await,
            0,
            "ON DELETE CASCADE must drop the outbound frontmatter row",
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM tags WHERE file_path='note.md'").await,
            0,
            "ON DELETE CASCADE must drop the outbound tag row",
        );
    }

    #[test]
    fn file_changed_payload_carries_hash_on_modified() {
        let payload = file_changed_payload(
            "v1",
            &WatchEvent::Modified(PathBuf::from("note.md")),
            Some("abc123".into()),
        );
        assert!(matches!(payload.kind, VaultFileChangeKind::Modified));
        assert_eq!(payload.path, "note.md");
        assert_eq!(payload.new_content_hash.as_deref(), Some("abc123"));
        assert!(payload.from_path.is_none());
    }

    #[test]
    fn file_changed_payload_drops_hash_on_removed() {
        let payload = file_changed_payload(
            "v1",
            &WatchEvent::Removed(PathBuf::from("note.md")),
            Some("ignored".into()),
        );
        assert!(payload.new_content_hash.is_none());
    }

    #[tokio::test]
    async fn own_write_gate_consumes_matching_modified_entry() {
        let gate: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
        gate.lock()
            .await
            .insert((PathBuf::from("a.md"), "deadbeef".into()));

        let suppressed = consume_own_write_hash(
            &gate,
            &WatchEvent::Modified(PathBuf::from("a.md")),
            Some("deadbeef"),
        )
        .await;
        assert!(suppressed, "matching modify+hash must drain the entry");

        let suppressed_again = consume_own_write_hash(
            &gate,
            &WatchEvent::Modified(PathBuf::from("a.md")),
            Some("deadbeef"),
        )
        .await;
        assert!(!suppressed_again, "entry must be consumed on first match");
    }

    #[tokio::test]
    async fn own_write_gate_lets_external_edit_through() {
        let gate: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
        gate.lock()
            .await
            .insert((PathBuf::from("a.md"), "deadbeef".into()));

        let suppressed = consume_own_write_hash(
            &gate,
            &WatchEvent::Modified(PathBuf::from("a.md")),
            Some("cafebabe"),
        )
        .await;
        assert!(!suppressed);
        assert_eq!(gate.lock().await.len(), 1, "non-match leaves entry intact");
    }

    #[tokio::test]
    async fn own_write_gate_ignores_non_modified_events() {
        let gate: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
        gate.lock()
            .await
            .insert((PathBuf::from("a.md"), "deadbeef".into()));

        for ev in [
            WatchEvent::Created(PathBuf::from("a.md")),
            WatchEvent::Removed(PathBuf::from("a.md")),
            WatchEvent::Renamed {
                from: PathBuf::from("a.md"),
                to: PathBuf::from("b.md"),
            },
        ] {
            assert!(!consume_own_write_hash(&gate, &ev, Some("deadbeef")).await);
        }
        assert_eq!(
            gate.lock().await.len(),
            1,
            "non-Modified events must not drain entries",
        );
    }

    #[test]
    fn file_changed_payload_drops_hash_on_renamed() {
        let payload = file_changed_payload(
            "v1",
            &WatchEvent::Renamed {
                from: PathBuf::from("a.md"),
                to: PathBuf::from("b.md"),
            },
            Some("ignored".into()),
        );
        assert!(payload.new_content_hash.is_none());
        assert_eq!(payload.from_path.as_deref(), Some("a.md"));
        assert_eq!(payload.path, "b.md");
    }

    #[tokio::test]
    async fn modified_event_refreshes_search_index() {
        use cubical_search::query::run_search;
        use cubical_search::{FieldScope, SearchQuery, SortMode};

        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "old body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Created(PathBuf::from("note.md"))],
            None,
        )
        .await;
        std::fs::write(&p, "freshly indexed unicorn token\n").unwrap();
        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Modified(PathBuf::from("note.md"))],
            None,
        )
        .await;

        assert_eq!(vault.search().doc_count().unwrap(), 1);

        let resp = run_search(
            vault.search(),
            &SearchQuery {
                text: "unicorn".into(),
                limit: 10,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .expect("run_search");
        assert_eq!(resp.hits.len(), 1, "post-Modified body must be indexed");
        assert_eq!(resp.hits[0].path, "note.md");

        let stale = run_search(
            vault.search(),
            &SearchQuery {
                text: "old".into(),
                limit: 10,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .expect("run_search");
        assert!(
            stale.hits.is_empty(),
            "Modified must replace, not append: {:?}",
            stale.hits,
        );
    }

    #[tokio::test]
    async fn removed_event_drops_doc_from_search_index() {
        let (_dir, vault) = fresh_vault_with_one_md("gone.md").await;
        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Created(PathBuf::from("gone.md"))],
            None,
        )
        .await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            1,
            "Created should seed exactly one search doc",
        );

        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Removed(PathBuf::from("gone.md"))],
            None,
        )
        .await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            0,
            "Removed should drop the search doc",
        );
    }

    #[tokio::test]
    async fn renamed_event_drops_old_path_from_search_index() {
        let (_dir, vault) = fresh_vault_with_one_md("a.md").await;
        apply_watch_events_batch(&vault, &[WatchEvent::Created(PathBuf::from("a.md"))], None).await;
        assert_eq!(vault.search().doc_count().unwrap(), 1);

        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Renamed {
                from: PathBuf::from("a.md"),
                to: PathBuf::from("b.md"),
            }],
            None,
        )
        .await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            0,
            "Renamed must remove the old path's search doc",
        );
    }

    #[tokio::test]
    async fn batch_commits_once_for_many_events() {
        let dir = tempdir().unwrap();
        let n = 50usize;
        let mut events = Vec::with_capacity(n);
        for i in 0..n {
            let rel = format!("note{i}.md");
            std::fs::write(
                dir.path().join(&rel),
                format!("# Note {i}\n\nbody token{i}\n"),
            )
            .unwrap();
            events.push(WatchEvent::Modified(PathBuf::from(rel)));
        }
        let vault = Vault::open(dir.path()).await.expect("vault open");

        let before = vault.search().commit_count();
        apply_watch_events_batch(&vault, &events, None).await;
        let delta = vault.search().commit_count() - before;

        assert_eq!(
            delta, 1,
            "a batch of {n} events must commit exactly once (got {delta})"
        );
        assert_eq!(
            vault.search().doc_count().unwrap(),
            n as u64,
            "all batched docs must be searchable after the single commit",
        );
    }

    mod adoption {
        use super::*;
        use crate::api::types::{FlushPendingRewritesRequest, RenameFileRequest};
        use crate::commands::rename::{flush_pending_rewrites, rename_file};
        use crate::state::AppState;
        use cubical_core::vault::rename_journal::{read_entries, RenameJournalEntry};
        use cubical_core::{start_watcher, WatcherHandle};
        use std::time::Duration;
        use tempfile::TempDir;

        const POLL_STEP: Duration = Duration::from_millis(25);

        const POLL_LIMIT: usize = 240;

        const SETTLE: Duration = Duration::from_millis(500);

        const VAULT_ID: &str = "v1";

        struct LiveVault {
            state: AppState,
            vault: Vault,
            _watcher: WatcherHandle,
        }

        async fn live_vault(dir: &TempDir, seed: &[&str]) -> LiveVault {
            let vault = Vault::open(dir.path()).await.expect("vault open");
            for rel in seed {
                apply_watch_events_batch(&vault, &[WatchEvent::Created(PathBuf::from(rel))], None)
                    .await;
            }

            let state = AppState::new();
            let open = OpenVault::new(
                vault.clone(),
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                SettingsMap::new(),
            );
            let flush_own_writes = open.flush_own_writes.clone();
            let settings = open.settings.clone();
            state.vaults().write().await.insert(VAULT_ID.into(), open);

            let (tx, rx) = mpsc::channel::<WatchEvent>(256);
            let watcher =
                start_watcher(&vault, CancellationToken::new(), tx).expect("start watcher");
            spawn_watcher_dispatcher(
                Arc::new(NoopEventSink),
                VAULT_ID.into(),
                vault.clone(),
                rx,
                flush_own_writes,
                settings,
            );
            tokio::time::sleep(SETTLE).await;

            LiveVault {
                state,
                vault,
                _watcher: watcher,
            }
        }

        async fn wait_for_file_row(vault: &Vault, path: &str) {
            for _ in 0..POLL_LIMIT {
                if file_row_exists(vault, path).await {
                    return;
                }
                tokio::time::sleep(POLL_STEP).await;
            }
        }

        async fn file_row_exists(vault: &Vault, path: &str) -> bool {
            let mut rows = vault
                .index()
                .connection()
                .query("SELECT 1 FROM files WHERE path = ?1", params![path])
                .await
                .unwrap();
            rows.next().await.unwrap().is_some()
        }

        async fn flush(state: &AppState) {
            flush_pending_rewrites(
                state,
                &NoopEventSink,
                FlushPendingRewritesRequest {
                    vault_id: VAULT_ID.into(),
                },
            )
            .await
            .expect("flush");
        }

        fn watch_ctx<'a>(
            flush_own_writes: &'a FlushOwnWrites,
            settings: &'a RwLock<SettingsMap>,
        ) -> WatchContext<'a> {
            WatchContext {
                sink: &NoopEventSink,
                vault_id: VAULT_ID,
                flush_own_writes,
                settings,
            }
        }

        async fn wait_for_journal_entry(vault: &Vault, from: &str) -> Vec<RenameJournalEntry> {
            for _ in 0..POLL_LIMIT {
                let entries = read_entries(vault.root());
                if entries.iter().any(|e| e.from == from) {
                    return entries;
                }
                tokio::time::sleep(POLL_STEP).await;
            }
            read_entries(vault.root())
        }

        #[tokio::test]
        async fn real_watcher_adopts_an_out_of_band_rename_and_rewrites_referrers_on_disk() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Seed.md"), "# Daily\n").unwrap();
            let live = live_vault(&dir, &["Seed.md"]).await;

            std::fs::rename(dir.path().join("Seed.md"), dir.path().join("Daily.md"))
                .expect("warm-up move");
            wait_for_file_row(&live.vault, "Daily.md").await;
            assert!(
                file_row_exists(&live.vault, "Daily.md").await,
                "the warm-up move must leave the file tracked at Daily.md",
            );

            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            wait_for_file_row(&live.vault, "Project.md").await;

            std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md"))
                .expect("out-of-band move");

            let entries = wait_for_journal_entry(&live.vault, "Daily.md").await;
            let adopted: Vec<_> = entries.iter().filter(|e| e.from == "Daily.md").collect();
            assert_eq!(
                adopted.len(),
                1,
                "the external move is adopted and journalled exactly once (entries: {entries:?})",
            );
            assert_eq!(adopted[0].to, "Journal.md");
            assert_eq!(adopted[0].kind, "file");

            assert!(file_row_exists(&live.vault, "Journal.md").await);
            assert!(!file_row_exists(&live.vault, "Daily.md").await);

            flush(&live.state).await;
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                "see [[Journal]] today\n",
                "the referrer wikilink is rewritten on disk",
            );
        }

        #[tokio::test]
        async fn real_watcher_does_not_double_apply_an_in_app_rename() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            let live = live_vault(&dir, &["Daily.md", "Project.md"]).await;

            rename_file(
                &live.state,
                &NoopEventSink,
                RenameFileRequest {
                    vault_id: VAULT_ID.into(),
                    from_path: "Daily.md".into(),
                    to_path: "Journal.md".into(),
                },
            )
            .await
            .expect("in-app rename");

            tokio::time::sleep(Duration::from_millis(1000)).await;

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            apply_watch_event_to_db(
                &live.vault,
                &WatchEvent::Renamed {
                    from: PathBuf::from("Daily.md"),
                    to: PathBuf::from("Journal.md"),
                },
                Some(&watch_ctx(&flush_own_writes, &settings)),
            )
            .await;

            let entries = read_entries(live.vault.root());
            assert_eq!(
                entries.len(),
                1,
                "the in-app rename is journalled once and never re-adopted (entries: {entries:?})",
            );

            let pending = cubical_index::pending_for_target(live.vault.index(), "Project.md")
                .await
                .unwrap();
            assert_eq!(pending.len(), 1, "exactly one queued rewrite");
            assert_eq!(pending[0].old_token, "Daily");
            assert_eq!(pending[0].new_token, "Journal");

            flush(&live.state).await;
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                "see [[Journal]] today\n",
                "the referrer is rewritten exactly once",
            );
        }

        #[tokio::test]
        async fn renamed_event_adopts_an_external_move_and_rewrites_referrers_on_disk() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            let live = live_vault(&dir, &["Daily.md", "Project.md"]).await;

            std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md")).unwrap();

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            let hash = apply_watch_event_to_db(
                &live.vault,
                &WatchEvent::Renamed {
                    from: PathBuf::from("Daily.md"),
                    to: PathBuf::from("Journal.md"),
                },
                Some(&watch_ctx(&flush_own_writes, &settings)),
            )
            .await;
            assert!(hash.is_none(), "Renamed must not carry a hash");

            assert!(file_row_exists(&live.vault, "Journal.md").await);
            assert!(!file_row_exists(&live.vault, "Daily.md").await);

            let entries = read_entries(live.vault.root());
            assert_eq!(entries.len(), 1, "the adoption is journalled");
            assert_eq!(entries[0].from, "Daily.md");
            assert_eq!(entries[0].to, "Journal.md");
            assert_eq!(entries[0].kind, "file");

            flush(&live.state).await;
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                "see [[Journal]] today\n",
                "the referrer wikilink is rewritten on disk",
            );
        }

        #[tokio::test]
        async fn already_committed_rename_is_not_adopted_again() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Journal.md"), "# Daily\n").unwrap();
            let vault = Vault::open(dir.path()).await.expect("vault open");
            apply_watch_event_to_db(
                &vault,
                &WatchEvent::Created(PathBuf::from("Journal.md")),
                None,
            )
            .await;

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            apply_watch_event_to_db(
                &vault,
                &WatchEvent::Renamed {
                    from: PathBuf::from("Daily.md"),
                    to: PathBuf::from("Journal.md"),
                },
                Some(&watch_ctx(&flush_own_writes, &settings)),
            )
            .await;

            assert!(
                read_entries(vault.root()).is_empty(),
                "an index that already reflects the move must not be re-adopted",
            );
        }

        #[tokio::test]
        async fn binary_file_rename_is_adopted_and_rekeys_the_file_row() {
            let dir = tempdir().unwrap();
            let png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE];
            std::fs::write(dir.path().join("logo.png"), png).unwrap();
            let vault = Vault::open(dir.path()).await.expect("vault open");
            apply_watch_event_to_db(
                &vault,
                &WatchEvent::Created(PathBuf::from("logo.png")),
                None,
            )
            .await;
            assert!(file_row_exists(&vault, "logo.png").await);

            std::fs::rename(dir.path().join("logo.png"), dir.path().join("brand.png")).unwrap();

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            let hash = apply_watch_event_to_db(
                &vault,
                &WatchEvent::Renamed {
                    from: PathBuf::from("logo.png"),
                    to: PathBuf::from("brand.png"),
                },
                Some(&watch_ctx(&flush_own_writes, &settings)),
            )
            .await;
            assert!(hash.is_none(), "Renamed must not carry a hash");

            assert!(
                file_row_exists(&vault, "brand.png").await,
                "a non-UTF-8 file is rekeyed rather than erroring out",
            );
            assert!(!file_row_exists(&vault, "logo.png").await);
            assert_eq!(read_entries(vault.root()).len(), 1);
        }

        #[tokio::test]
        async fn folder_rename_is_not_adopted() {
            let dir = tempdir().unwrap();
            std::fs::create_dir(dir.path().join("notes")).unwrap();
            let vault = Vault::open(dir.path()).await.expect("vault open");
            apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("notes")), None)
                .await;
            std::fs::rename(dir.path().join("notes"), dir.path().join("archive")).unwrap();

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            apply_watch_event_to_db(
                &vault,
                &WatchEvent::Renamed {
                    from: PathBuf::from("notes"),
                    to: PathBuf::from("archive"),
                },
                Some(&watch_ctx(&flush_own_writes, &settings)),
            )
            .await;

            assert!(
                read_entries(vault.root()).is_empty(),
                "folder renames stay out of scope for v1 adoption",
            );
        }
    }
}
