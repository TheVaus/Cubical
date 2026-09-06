use cubical_core::unix_now_secs;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tokio::sync::{mpsc, Mutex, RwLock};

use cubical_core::vault::links::read_source_off_executor;
use cubical_core::vault::pending::materialize_on_read;
use cubical_core::vault::settings::SettingsMap;
use cubical_core::{
    parse_off_executor, refresh_block_refs_for_file, refresh_blocks, refresh_frontmatter_with_doc,
    refresh_links_with_doc, refresh_tags_with_doc, scan, ScanProgress, Vault, VaultError,
    WatchEvent,
};
use libsql::params;
use tokio_util::sync::CancellationToken;

use crate::rename_pairing::{
    capture_tombstone, drop_row, find_rename_source, forget_tombstone, new_tombstones,
    path_is_tracked, restore_row, RenameSource, Tombstones,
};
use crate::state::{OpenVault, ScanStatusBackend};

pub type FlushOwnWrites = Arc<Mutex<HashSet<(String, String)>>>;

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
        let scan_started_secs = unix_now_secs();
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
            Ok(Ok(outcome)) => {
                journal_renames_found_by_scan(&vault, &outcome, scan_started_secs).await;
                crate::commands::rename::replay_rename_journal(&vault, sink.as_ref(), &vault_id)
                    .await;
                emit_scan_complete(
                    sink.as_ref(),
                    VaultScanComplete {
                        vault_id: vault_id.clone(),
                        file_count: outcome.file_count,
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
    pub tombstones: &'a Tombstones,
}

pub struct WatcherLifetime {
    pub cancel: CancellationToken,
    pub live: Arc<AtomicBool>,
}

pub(crate) const WATCHER_UNAVAILABLE: &str = "watcher_unavailable";

pub(crate) const WATCHER_BATCH_PANIC: &str = "watcher_batch_panic";

pub(crate) async fn record_vault_warning(
    vault: &Vault,
    category: &str,
    message: &str,
    error: &str,
) {
    if let Err(e) = cubical_index::append_audit(
        vault.index(),
        cubical_index::AuditLevel::Warn,
        category,
        message,
        &serde_json::json!({ "error": error }).to_string(),
        unix_now_secs(),
    )
    .await
    {
        tracing::warn!(error = %e, category, "degraded-subsystem audit insert failed");
    }
}

pub fn spawn_watcher_dispatcher(
    sink: Arc<dyn EventSink>,
    vault_id: String,
    vault: Vault,
    mut events_rx: tokio::sync::mpsc::Receiver<WatchEvent>,
    flush_own_writes: FlushOwnWrites,
    settings: Arc<RwLock<SettingsMap>>,
    lifetime: WatcherLifetime,
) {
    tokio::spawn(async move {
        let tombstones = new_tombstones();
        while let Some(first) = events_rx.recv().await {
            let mut batch = vec![first];
            while let Ok(next) = events_rx.try_recv() {
                batch.push(next);
            }
            let sink = Arc::clone(&sink);
            let batch_vault_id = vault_id.clone();
            let batch_vault = vault.clone();
            let flush_own_writes = Arc::clone(&flush_own_writes);
            let settings = Arc::clone(&settings);
            let tombstones = Arc::clone(&tombstones);
            let batch_task = tokio::spawn(async move {
                let ctx = WatchContext {
                    sink: sink.as_ref(),
                    vault_id: &batch_vault_id,
                    flush_own_writes: &flush_own_writes,
                    settings: settings.as_ref(),
                    tombstones: &tombstones,
                };
                handle_watch_batch(&batch_vault, batch, &ctx).await;
            });
            if let Err(e) = batch_task.await {
                tracing::error!(vault_id = %vault_id, error = %e, "watcher: batch handler died; dropping that batch and staying up");
                record_vault_warning(
                    &vault,
                    WATCHER_BATCH_PANIC,
                    "watcher batch handler died; that batch of external edits was dropped",
                    &e.to_string(),
                )
                .await;
            }
        }
        if lifetime.cancel.is_cancelled() {
            tracing::debug!(vault_id = %vault_id, "watcher dispatcher: channel closed after cancellation");
            return;
        }
        lifetime.live.store(false, Ordering::Relaxed);
        tracing::error!(vault_id = %vault_id, "watcher: event stream ended while the vault is open; external edits will not be seen until reopen");
        record_vault_warning(
            &vault,
            WATCHER_UNAVAILABLE,
            "watcher event stream ended while the vault was open; external edits will not be seen until reopen",
            "watch event channel closed",
        )
        .await;
    });
}

async fn journal_renames_found_by_scan(
    vault: &Vault,
    outcome: &cubical_core::ScanOutcome,
    scan_started_secs: i64,
) {
    let pairs = crate::rename_pairing::pair_vanished_after_scan(
        vault,
        &outcome.vanished,
        scan_started_secs,
    )
    .await;
    for (from, to) in pairs {
        let entry = cubical_core::vault::rename_journal::RenameJournalEntry {
            op_id: 0,
            kind: "file".to_string(),
            from: from.clone(),
            to: to.clone(),
            at: unix_now_secs(),
        };
        match cubical_core::vault::rename_journal::append_entry(vault.root(), &entry) {
            Ok(()) => tracing::info!(
                %from,
                %to,
                "scan: paired a rename made while the vault was not open",
            ),
            Err(e) => tracing::warn!(%from, %to, error = %e, "scan: rename journal append failed"),
        }
    }
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

pub(crate) async fn refresh_watched_markdown(
    vault: &Vault,
    path: &str,
    source: &str,
    mtime: i64,
    doc: Option<&cubical_ast::Document>,
) {
    let Some(doc) = doc else {
        tracing::warn!(
            path,
            "watcher: markdown parse failed; derived tables left untouched"
        );
        return;
    };
    if let Err(e) = refresh_frontmatter_with_doc(vault, path, doc).await {
        tracing::warn!(path, error = %e, "watcher: frontmatter refresh failed");
    }
    if let Err(e) = refresh_links_with_doc(vault, path, doc).await {
        tracing::warn!(path, error = %e, "watcher: links refresh failed");
    }
    if let Err(e) = refresh_tags_with_doc(vault, path, doc).await {
        tracing::warn!(path, error = %e, "watcher: tags refresh failed");
    }
    if let Err(e) = refresh_blocks(vault, path, source).await {
        tracing::warn!(path, error = %e, "watcher: blocks refresh failed");
    }
    if let Err(e) = refresh_block_refs_for_file(vault, path).await {
        tracing::warn!(path, error = %e, "watcher: block_refs refresh failed");
    }
    if let Err(e) = cubical_core::vault::search_refresh::refresh_search_index_with_doc(
        vault,
        path,
        doc,
        mtime,
        source.len() as u64,
    )
    .await
    {
        tracing::warn!(path, error = %e, "watcher: search refresh failed");
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
            let path_str = rel.clone();
            if let Err(e) = cubical_index::upsert_folder(vault.index(), &path_str, now).await {
                tracing::warn!(path = %path_str, error = %e, "watcher: folder upsert failed");
            }
            let (message, detail) = audit_payload_for(ev);
            if let Err(e) = cubical_index::append_audit(
                vault.index(),
                cubical_index::AuditLevel::Info,
                "watcher",
                &message,
                &detail,
                now,
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
            let path_str = rel.clone();
            let stats = read_file_stats(&abs, vault).await.unwrap_or_default();

            if matches!(ev, WatchEvent::Created(_)) {
                try_pair_created_as_rename(vault, ctx, &path_str, &stats, now).await;
            }

            let FileStats {
                size,
                mtime,
                hash,
                inode,
            } = stats;
            let type_id = vault
                .registry()
                .handler_for(&abs)
                .map(|h| h.type_id().to_string())
                .unwrap_or_else(|| "binary".into());

            if let Err(e) = cubical_index::upsert_file(
                vault.index(),
                &cubical_index::FileRow {
                    path: &path_str,
                    type_id: &type_id,
                    size_bytes: size,
                    mtime_unix: mtime,
                    content_hash: &hash,
                    inode,
                    seen_at: now,
                },
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

                let doc = parse_off_executor(&source).await;
                refresh_watched_markdown(vault, &path_str, &source, mtime, doc.as_ref()).await;
            }

            if hash.is_empty() {
                None
            } else {
                Some(hash)
            }
        }
        WatchEvent::Removed(rel) => {
            let path_str = rel.clone();
            if let Some(ctx) = ctx {
                capture_tombstone(vault, ctx.tombstones, &path_str).await;
            }
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
            let from_str = from.clone();
            let to_str = to.clone();

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
    if let Err(e) = cubical_index::append_audit(
        vault.index(),
        cubical_index::AuditLevel::Info,
        "watcher",
        &message,
        &detail,
        now,
    )
    .await
    {
        tracing::warn!(error = %e, "watcher: audit_log insert failed");
    }

    new_content_hash
}

async fn try_pair_created_as_rename(
    vault: &Vault,
    ctx: Option<&WatchContext<'_>>,
    to_path: &str,
    stats: &FileStats,
    now: i64,
) -> bool {
    let Some(ctx) = ctx else {
        return false;
    };
    if to_path.is_empty() || !vault.root().join(to_path).is_file() {
        return false;
    }
    if path_is_tracked(vault, to_path).await {
        return false;
    }

    let Some(source) =
        find_rename_source(vault, ctx.tombstones, to_path, stats.inode, &stats.hash).await
    else {
        return false;
    };

    let from_path = source.path().to_string();
    let restored = match &source {
        RenameSource::Tombstoned(tombstone) => restore_row(vault, tombstone, now).await,
        RenameSource::Tracked(_) => false,
    };

    let adopted = try_adopt_external_rename(vault, Some(ctx), &from_path, to_path).await;
    if adopted {
        forget_tombstone(ctx.tombstones, &from_path).await;
        tracing::info!(
            from = %from_path,
            to = %to_path,
            "watcher: recovered an unpaired external rename",
        );
    } else if restored {
        drop_row(vault, &from_path).await;
    }
    adopted
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
    let inode = cubical_core::vault::inode_of(&metadata);

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
            format!("created {}", p),
            serde_json::json!({ "kind": "created", "path": p }).to_string(),
        ),
        WatchEvent::Modified(p) => (
            format!("modified {}", p),
            serde_json::json!({ "kind": "modified", "path": p }).to_string(),
        ),
        WatchEvent::Removed(p) => (
            format!("removed {}", p),
            serde_json::json!({ "kind": "removed", "path": p }).to_string(),
        ),
        WatchEvent::Renamed { from, to } => (
            format!("renamed {} → {}", from, to),
            serde_json::json!({
                "kind": "renamed",
                "from": from,
                "to": to,
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
            path: p.clone(),
            kind: VaultFileChangeKind::Created,
            from_path: None,
            new_content_hash,
        },
        WatchEvent::Modified(p) => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: p.clone(),
            kind: VaultFileChangeKind::Modified,
            from_path: None,
            new_content_hash,
        },
        WatchEvent::Removed(p) => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: p.clone(),
            kind: VaultFileChangeKind::Removed,
            from_path: None,
            new_content_hash: None,
        },
        WatchEvent::Renamed { from, to } => VaultFileChanged {
            vault_id: vault_id.to_string(),
            path: to.clone(),
            kind: VaultFileChangeKind::Renamed,
            from_path: Some(from.clone()),
            new_content_hash: None,
        },
    }
}

#[cfg(test)]
mod tests {

    use super::*;
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
            apply_watch_event_to_db(&vault, &WatchEvent::Created("note.md".into()), None).await;
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

    async fn audit_categories(vault: &Vault) -> Vec<String> {
        let conn = vault.index().connection();
        let mut rows = conn
            .query("SELECT category FROM audit_log", ())
            .await
            .expect("query");
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.expect("row") {
            out.push(row.get::<String>(0).expect("category"));
        }
        out
    }

    fn spawn_dispatcher_for(
        vault: &Vault,
        rx: mpsc::Receiver<WatchEvent>,
        lifetime: WatcherLifetime,
    ) {
        spawn_watcher_dispatcher(
            Arc::new(NoopEventSink),
            "v1".into(),
            vault.clone(),
            rx,
            Arc::new(Mutex::new(HashSet::new())),
            Arc::new(RwLock::new(SettingsMap::new())),
            lifetime,
        );
    }

    async fn settle_for(millis: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
    }

    #[tokio::test]
    async fn dispatcher_flags_and_audits_a_watcher_that_dies_while_the_vault_is_open() {
        let (_dir, vault) = fresh_vault_with_one_md("note.md").await;
        let (tx, rx) = mpsc::channel::<WatchEvent>(8);
        let live = Arc::new(AtomicBool::new(true));
        spawn_dispatcher_for(
            &vault,
            rx,
            WatcherLifetime {
                cancel: CancellationToken::new(),
                live: Arc::clone(&live),
            },
        );

        drop(tx);
        for _ in 0..200 {
            if !live.load(Ordering::Relaxed) {
                break;
            }
            settle_for(10).await;
        }

        assert!(
            !live.load(Ordering::Relaxed),
            "an event stream that ends without cancellation must clear the live flag",
        );
        for _ in 0..200 {
            if audit_categories(&vault)
                .await
                .iter()
                .any(|c| c == WATCHER_UNAVAILABLE)
            {
                return;
            }
            settle_for(10).await;
        }
        panic!("a dead watcher must leave a {WATCHER_UNAVAILABLE} row in audit_log");
    }

    #[tokio::test]
    async fn dispatcher_stays_quiet_when_the_stream_ends_because_the_vault_closed() {
        let (_dir, vault) = fresh_vault_with_one_md("note.md").await;
        let (tx, rx) = mpsc::channel::<WatchEvent>(8);
        let live = Arc::new(AtomicBool::new(true));
        let cancel = CancellationToken::new();
        spawn_dispatcher_for(
            &vault,
            rx,
            WatcherLifetime {
                cancel: cancel.clone(),
                live: Arc::clone(&live),
            },
        );

        cancel.cancel();
        drop(tx);
        settle_for(300).await;

        assert!(
            live.load(Ordering::Relaxed),
            "a deliberate close is not a degraded watcher",
        );
        assert!(
            !audit_categories(&vault)
                .await
                .iter()
                .any(|c| c == WATCHER_UNAVAILABLE),
            "a deliberate close must not be audited as a dead watcher",
        );
    }

    const WATCHED_FIXTURE: &str =
        "---\ntitle: Keep Me\n---\n\nlinks to [[b]] and tagged #keepme\n\nblock line ^blk1\n";

    async fn count(vault: &Vault, sql: &str) -> i64 {
        let conn = vault.index().connection();
        let mut rows = conn.query(sql, ()).await.expect("query");
        rows.next().await.unwrap().expect("row").get(0).unwrap()
    }

    async fn watched_derived_counts(vault: &Vault) -> (i64, i64, i64, i64) {
        (
            count(
                vault,
                "SELECT COUNT(*) FROM frontmatter WHERE file_path = 'a.md'",
            )
            .await,
            count(
                vault,
                "SELECT COUNT(*) FROM links WHERE source_path = 'a.md'",
            )
            .await,
            count(vault, "SELECT COUNT(*) FROM tags WHERE file_path = 'a.md'").await,
            count(
                vault,
                "SELECT COUNT(*) FROM blocks WHERE file_path = 'a.md'",
            )
            .await,
        )
    }

    async fn watched_fixture() -> (tempfile::TempDir, Vault) {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), WATCHED_FIXTURE).unwrap();
        std::fs::write(dir.path().join("b.md"), "body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");
        apply_watch_event_to_db(&vault, &WatchEvent::Created("b.md".into()), None).await;
        apply_watch_event_to_db(&vault, &WatchEvent::Created("a.md".into()), None).await;
        (dir, vault)
    }

    #[tokio::test]
    async fn watcher_path_keeps_derived_rows_when_the_parse_yields_nothing() {
        let (_dir, vault) = watched_fixture().await;

        let before = watched_derived_counts(&vault).await;
        assert!(
            before.0 > 0 && before.1 > 0 && before.2 > 0 && before.3 > 0,
            "fixture must seed frontmatter, links, tags and blocks; got {before:?}",
        );

        refresh_watched_markdown(&vault, "a.md", WATCHED_FIXTURE, 0, None).await;

        assert_eq!(
            watched_derived_counts(&vault).await,
            before,
            "a failed parse must leave the file's derived rows untouched",
        );
    }

    #[tokio::test]
    async fn watcher_path_wipes_derived_rows_for_a_genuinely_empty_document() {
        let (_dir, vault) = watched_fixture().await;
        assert_ne!(watched_derived_counts(&vault).await, (0, 0, 0, 0));

        refresh_watched_markdown(
            &vault,
            "a.md",
            "",
            0,
            Some(&cubical_ast::Document::default()),
        )
        .await;

        assert_eq!(
            watched_derived_counts(&vault).await,
            (0, 0, 0, 0),
            "an empty document really does mean the file has no frontmatter, links, tags or blocks",
        );
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

        apply_watch_event_to_db(&vault, &WatchEvent::Created("fresh.md".into()), None).await;

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

        apply_watch_event_to_db(&vault, &WatchEvent::Created("note.md".into()), None).await;
        let first = read_inode_column(&vault, "note.md")
            .await
            .expect("inode set");

        let swap = dir.path().join("swap.tmp");
        std::fs::write(&swap, "replaced\n").unwrap();
        std::fs::rename(&swap, &note).unwrap();
        let replaced = i64::try_from(std::fs::metadata(&note).unwrap().ino()).unwrap();
        assert_ne!(first, replaced, "replacement must change the inode");

        apply_watch_event_to_db(&vault, &WatchEvent::Modified("note.md".into()), None).await;

        assert_eq!(
            read_inode_column(&vault, "note.md").await,
            Some(replaced),
            "ON CONFLICT must refresh inode, not keep the stale one"
        );
    }

    #[tokio::test]
    async fn created_event_on_missing_file_leaves_inode_null() {
        let (_dir, vault) = fresh_vault_with_one_md("note.md").await;

        apply_watch_event_to_db(&vault, &WatchEvent::Created("ghost.md".into()), None).await;

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

        let h1 = apply_watch_event_to_db(&vault, &WatchEvent::Created("note.md".into()), None)
            .await
            .expect("Created hash");
        std::fs::write(&p, "---\ntitle: New\nstatus: ready\n---\n\nbody\n").unwrap();
        let h2 = apply_watch_event_to_db(&vault, &WatchEvent::Modified("note.md".into()), None)
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

        apply_watch_event_to_db(&vault, &WatchEvent::Created("a.md".into()), None).await;
        apply_watch_event_to_db(&vault, &WatchEvent::Created("Daily.md".into()), None).await;

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

        let hash = apply_watch_event_to_db(&vault, &WatchEvent::Modified("a.md".into()), None)
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

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Created("projects".into()), None).await;
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
        apply_watch_event_to_db(&vault, &WatchEvent::Created("projects".into()), None).await;
        assert_eq!(
            cubical_index::list_folders(vault.index())
                .await
                .unwrap()
                .len(),
            1,
        );

        std::fs::remove_dir(dir.path().join("projects")).unwrap();
        apply_watch_event_to_db(&vault, &WatchEvent::Removed("projects".into()), None).await;
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
                from: "a.md".to_string(),
                to: "b.md".to_string(),
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
        apply_watch_event_to_db(&vault, &WatchEvent::Created("note.md".into()), None).await;

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Removed("note.md".into()), None).await;
        assert!(hash.is_none(), "Removed must not carry a hash");
    }

    #[tokio::test]
    async fn removed_event_deletes_files_row_and_cascades_children() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: Hi\n---\n\n#planning body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        apply_watch_event_to_db(&vault, &WatchEvent::Created("note.md".into()), None).await;
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
        apply_watch_event_to_db(&vault, &WatchEvent::Removed("note.md".into()), None).await;

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
            &WatchEvent::Modified("note.md".into()),
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
            &WatchEvent::Removed("note.md".into()),
            Some("ignored".into()),
        );
        assert!(payload.new_content_hash.is_none());
    }

    #[tokio::test]
    async fn own_write_gate_consumes_matching_modified_entry() {
        let gate: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
        gate.lock()
            .await
            .insert(("a.md".to_string(), "deadbeef".into()));

        let suppressed = consume_own_write_hash(
            &gate,
            &WatchEvent::Modified("a.md".into()),
            Some("deadbeef"),
        )
        .await;
        assert!(suppressed, "matching modify+hash must drain the entry");

        let suppressed_again = consume_own_write_hash(
            &gate,
            &WatchEvent::Modified("a.md".into()),
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
            .insert(("a.md".to_string(), "deadbeef".into()));

        let suppressed = consume_own_write_hash(
            &gate,
            &WatchEvent::Modified("a.md".into()),
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
            .insert(("a.md".to_string(), "deadbeef".into()));

        for ev in [
            WatchEvent::Created("a.md".into()),
            WatchEvent::Removed("a.md".into()),
            WatchEvent::Renamed {
                from: "a.md".to_string(),
                to: "b.md".to_string(),
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
                from: "a.md".to_string(),
                to: "b.md".to_string(),
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

        apply_watch_events_batch(&vault, &[WatchEvent::Created("note.md".into())], None).await;
        std::fs::write(&p, "freshly indexed unicorn token\n").unwrap();
        apply_watch_events_batch(&vault, &[WatchEvent::Modified("note.md".into())], None).await;

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
        apply_watch_events_batch(&vault, &[WatchEvent::Created("gone.md".into())], None).await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            1,
            "Created should seed exactly one search doc",
        );

        apply_watch_events_batch(&vault, &[WatchEvent::Removed("gone.md".into())], None).await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            0,
            "Removed should drop the search doc",
        );
    }

    #[tokio::test]
    async fn renamed_event_drops_old_path_from_search_index() {
        let (_dir, vault) = fresh_vault_with_one_md("a.md").await;
        apply_watch_events_batch(&vault, &[WatchEvent::Created("a.md".into())], None).await;
        assert_eq!(vault.search().doc_count().unwrap(), 1);

        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Renamed {
                from: "a.md".to_string(),
                to: "b.md".to_string(),
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
            events.push(WatchEvent::Modified(rel.to_string()));
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
        use cubical_core::vault::rename_journal::{read_journal, RenameJournalEntry};
        use cubical_core::{start_watcher, WatcherHandle};
        use std::time::Duration;
        use tempfile::TempDir;

        fn read_entries(root: &std::path::Path) -> Vec<RenameJournalEntry> {
            read_journal(root).expect("journal is readable").entries
        }

        const POLL_STEP: Duration = Duration::from_millis(25);

        const POLL_LIMIT: usize = 240;

        const SETTLE: Duration = Duration::from_millis(500);

        const VAULT_ID: &str = "v1";

        struct LiveVault {
            state: AppState,
            vault: Vault,
            _watcher: WatcherHandle,
        }

        #[derive(Default)]
        struct RecordingSink {
            events: std::sync::Mutex<Vec<AppEvent>>,
        }

        impl RecordingSink {
            fn pending_counts(&self) -> Vec<i64> {
                self.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|e| match e {
                        AppEvent::PendingRewritesChanged(p) => Some(p.count),
                        _ => None,
                    })
                    .collect()
            }

            fn changed_paths(&self) -> Vec<String> {
                self.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|e| match e {
                        AppEvent::FileChanged(p) => Some(p.path.clone()),
                        _ => None,
                    })
                    .collect()
            }
        }

        impl EventSink for RecordingSink {
            fn emit(&self, event: AppEvent) {
                self.events.lock().unwrap().push(event);
            }
        }

        async fn live_vault(dir: &TempDir, seed: &[&str]) -> LiveVault {
            live_vault_with_sink(dir, seed, Arc::new(NoopEventSink)).await
        }

        async fn live_vault_with_sink(
            dir: &TempDir,
            seed: &[&str],
            sink: Arc<dyn EventSink>,
        ) -> LiveVault {
            let vault = Vault::open(dir.path()).await.expect("vault open");
            for rel in seed {
                apply_watch_events_batch(&vault, &[WatchEvent::Created(rel.to_string())], None)
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
            let lifetime = WatcherLifetime {
                cancel: open.watcher_cancel.clone(),
                live: Arc::clone(&open.watcher_live),
            };
            state.vaults().write().await.insert(VAULT_ID.into(), open);

            let (tx, rx) = mpsc::channel::<WatchEvent>(256);
            let watcher =
                start_watcher(&vault, CancellationToken::new(), tx).expect("start watcher");
            spawn_watcher_dispatcher(
                sink,
                VAULT_ID.into(),
                vault.clone(),
                rx,
                flush_own_writes,
                settings,
                lifetime,
            );
            tokio::time::sleep(SETTLE).await;

            LiveVault {
                state,
                vault,
                _watcher: watcher,
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
            tombstones: &'a Tombstones,
        ) -> WatchContext<'a> {
            WatchContext {
                sink: &NoopEventSink,
                vault_id: VAULT_ID,
                flush_own_writes,
                settings,
                tombstones,
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
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            let live = live_vault(&dir, &["Daily.md", "Project.md"]).await;

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
            let tombstones = new_tombstones();
            apply_watch_event_to_db(
                &live.vault,
                &WatchEvent::Renamed {
                    from: "Daily.md".to_string(),
                    to: "Journal.md".to_string(),
                },
                Some(&watch_ctx(&flush_own_writes, &settings, &tombstones)),
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

        async fn wait_for_changed_path(sink: &RecordingSink, path: &str) -> bool {
            for _ in 0..POLL_LIMIT {
                if sink.changed_paths().iter().any(|p| p == path) {
                    return true;
                }
                tokio::time::sleep(POLL_STEP).await;
            }
            false
        }

        async fn reopen_after_closed_app_rename(
            dir: &TempDir,
            seed: &[(&str, &str)],
            renames: &[(&str, &str)],
            drop_inodes: bool,
        ) -> Vault {
            for (rel, body) in seed {
                let abs = dir.path().join(rel);
                std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
                std::fs::write(abs, body).unwrap();
            }
            {
                let vault = Vault::open(dir.path()).await.expect("open");
                let (tx, _rx) = mpsc::channel(64);
                cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
                    .await
                    .expect("scan");
                let sql = if drop_inodes {
                    "UPDATE files SET last_seen = last_seen - 60, inode = NULL"
                } else {
                    "UPDATE files SET last_seen = last_seen - 60"
                };
                vault.index().connection().execute(sql, ()).await.unwrap();
            }
            for (from, to) in renames {
                let to_abs = dir.path().join(to);
                std::fs::create_dir_all(to_abs.parent().unwrap()).unwrap();
                std::fs::rename(dir.path().join(from), to_abs).unwrap();
            }

            let vault = Vault::open(dir.path()).await.expect("reopen");
            let scan_started_secs = unix_now_secs();
            let (tx, _rx) = mpsc::channel(64);
            let outcome = cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
                .await
                .expect("rescan");
            journal_renames_found_by_scan(&vault, &outcome, scan_started_secs).await;
            crate::commands::rename::replay_rename_journal(&vault, &NoopEventSink, VAULT_ID).await;
            vault
        }

        async fn link_target(vault: &Vault, source: &str) -> Option<String> {
            let mut rows = vault
                .index()
                .connection()
                .query(
                    "SELECT target_path FROM links WHERE source_path = ?1",
                    params![source],
                )
                .await
                .unwrap();
            match rows.next().await.unwrap() {
                Some(r) => r.get(0).unwrap(),
                None => None,
            }
        }

        #[tokio::test]
        async fn a_rename_made_while_the_vault_was_closed_is_paired_and_rewritten() {
            let dir = tempdir().unwrap();
            let vault = reopen_after_closed_app_rename(
                &dir,
                &[("Daily.md", "# Daily\n"), ("Notes.md", "see [[Daily]]\n")],
                &[("Daily.md", "Journal.md")],
                true,
            )
            .await;

            assert_eq!(
                link_target(&vault, "Notes.md").await.as_deref(),
                Some("Journal.md"),
                "content hash alone pairs the move when no inode is recorded",
            );

            let pending = cubical_index::pending_for_target(vault.index(), "Notes.md")
                .await
                .unwrap();
            assert_eq!(pending.len(), 1, "the text rewrite is queued");
            assert_eq!(pending[0].old_token, "Daily");
            assert_eq!(pending[0].new_token, "Journal");
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn a_closed_app_rename_that_also_edited_the_file_pairs_on_inode() {
            let dir = tempdir().unwrap();
            for (rel, body) in [("Daily.md", "# Daily\n"), ("Notes.md", "see [[Daily]]\n")] {
                std::fs::write(dir.path().join(rel), body).unwrap();
            }
            {
                let vault = Vault::open(dir.path()).await.expect("open");
                let (tx, _rx) = mpsc::channel(64);
                cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
                    .await
                    .expect("scan");
                vault
                    .index()
                    .connection()
                    .execute("UPDATE files SET last_seen = last_seen - 60", ())
                    .await
                    .unwrap();
            }
            std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md")).unwrap();
            std::fs::write(dir.path().join("Journal.md"), "# Daily\n\nedited too\n").unwrap();

            let vault = Vault::open(dir.path()).await.expect("reopen");
            let scan_started_secs = unix_now_secs();
            let (tx, _rx) = mpsc::channel(64);
            let outcome = cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
                .await
                .expect("rescan");
            journal_renames_found_by_scan(&vault, &outcome, scan_started_secs).await;
            crate::commands::rename::replay_rename_journal(&vault, &NoopEventSink, VAULT_ID).await;

            assert_eq!(
                link_target(&vault, "Notes.md").await.as_deref(),
                Some("Journal.md"),
                "the content changed, so only the inode can pair this move",
            );
        }

        #[tokio::test]
        async fn two_closed_app_renames_sharing_content_are_refused() {
            let dir = tempdir().unwrap();
            let vault = reopen_after_closed_app_rename(
                &dir,
                &[
                    ("A.md", "same\n"),
                    ("B.md", "same\n"),
                    ("Notes.md", "see [[A]]\n"),
                ],
                &[("A.md", "X.md"), ("B.md", "Y.md")],
                true,
            )
            .await;

            let target = link_target(&vault, "Notes.md").await;
            assert_eq!(
                target, None,
                "with no inode to separate them, two files sharing content are \
                 indistinguishable — pairing must refuse rather than guess, since a wrong \
                 rewrite corrupts markdown (got {target:?})",
            );
        }

        #[tokio::test]
        async fn a_flush_announces_the_new_pending_count() {
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
            .expect("rename");

            let sink = RecordingSink::default();
            flush_pending_rewrites(
                &live.state,
                &sink,
                FlushPendingRewritesRequest {
                    vault_id: VAULT_ID.into(),
                },
            )
            .await
            .expect("flush");

            assert_eq!(
                sink.pending_counts(),
                vec![0],
                "the flush rewrote bytes the open buffers do not have, so it must announce \
                 the drained queue — that announcement is what pulls them back in",
            );
        }

        #[tokio::test]
        async fn adopting_an_external_rename_announces_the_queued_rewrites() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            let sink = Arc::new(RecordingSink::default());
            let live = live_vault_with_sink(&dir, &["Daily.md", "Project.md"], sink.clone()).await;

            std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md"))
                .expect("out-of-band move");

            wait_for_journal_entry(&live.vault, "Daily.md").await;

            let mut announced = false;
            for _ in 0..POLL_LIMIT {
                if sink.pending_counts().iter().any(|c| *c > 0) {
                    announced = true;
                    break;
                }
                tokio::time::sleep(POLL_STEP).await;
            }
            assert!(
                announced,
                "a rename adopted from outside the app queues referrer rewrites the open \
                 buffers do not have, so it must announce them (counts: {:?})",
                sink.pending_counts(),
            );
        }

        #[tokio::test]
        async fn flushing_a_rewrite_announces_the_referrer_change() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            let sink = Arc::new(RecordingSink::default());
            let live = live_vault_with_sink(&dir, &["Daily.md", "Project.md"], sink.clone()).await;

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
            .expect("rename");

            flush(&live.state).await;
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                "see [[Journal]] today\n",
            );

            assert!(
                wait_for_changed_path(&sink, "Project.md").await,
                "a flush rewrites bytes the frontend does not have, so it must \
                 emit vault:file-changed for the referrer (saw: {:?})",
                sink.changed_paths(),
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
            let tombstones = new_tombstones();
            let hash = apply_watch_event_to_db(
                &live.vault,
                &WatchEvent::Renamed {
                    from: "Daily.md".to_string(),
                    to: "Journal.md".to_string(),
                },
                Some(&watch_ctx(&flush_own_writes, &settings, &tombstones)),
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
        async fn a_padded_wikilink_is_reattached_because_the_parser_owns_the_trim() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[  Daily  ]] today\n").unwrap();
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

            let pending = cubical_index::pending_for_target(live.vault.index(), "Project.md")
                .await
                .unwrap();
            assert_eq!(pending.len(), 1, "the padded referrer is enqueued");
            assert_eq!(
                pending[0].old_token, "Daily",
                "the token was trimmed once, by the parser",
            );

            flush(&live.state).await;
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                "see [[Journal]] today\n",
                "the rewrite emits the canonical unpadded form",
            );
        }

        #[tokio::test]
        async fn renamed_event_adopts_a_case_only_external_rename() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
            std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
            let live = live_vault(&dir, &["Daily.md", "Project.md"]).await;

            std::fs::rename(dir.path().join("Daily.md"), dir.path().join("daily.md")).unwrap();

            let folds_case = dir.path().join("DAILY.md").exists();
            assert_eq!(
                dir.path().join("Daily.md").exists(),
                folds_case,
                "only a folding volume still reports the old spelling as present, \
                 and that is the leg where a bare exists() declines the adoption",
            );

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            let tombstones = new_tombstones();
            apply_watch_event_to_db(
                &live.vault,
                &WatchEvent::Renamed {
                    from: "Daily.md".to_string(),
                    to: "daily.md".to_string(),
                },
                Some(&watch_ctx(&flush_own_writes, &settings, &tombstones)),
            )
            .await;

            assert!(file_row_exists(&live.vault, "daily.md").await);
            assert!(!file_row_exists(&live.vault, "Daily.md").await);

            flush(&live.state).await;
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                "see [[daily]] today\n",
                "a case-only external rename reattaches its referrers",
            );
        }

        #[tokio::test]
        async fn already_committed_rename_is_not_adopted_again() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("Journal.md"), "# Daily\n").unwrap();
            let vault = Vault::open(dir.path()).await.expect("vault open");
            apply_watch_event_to_db(&vault, &WatchEvent::Created("Journal.md".into()), None).await;

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            let tombstones = new_tombstones();
            apply_watch_event_to_db(
                &vault,
                &WatchEvent::Renamed {
                    from: "Daily.md".to_string(),
                    to: "Journal.md".to_string(),
                },
                Some(&watch_ctx(&flush_own_writes, &settings, &tombstones)),
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
            apply_watch_event_to_db(&vault, &WatchEvent::Created("logo.png".into()), None).await;
            assert!(file_row_exists(&vault, "logo.png").await);

            std::fs::rename(dir.path().join("logo.png"), dir.path().join("brand.png")).unwrap();

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            let tombstones = new_tombstones();
            let hash = apply_watch_event_to_db(
                &vault,
                &WatchEvent::Renamed {
                    from: "logo.png".to_string(),
                    to: "brand.png".to_string(),
                },
                Some(&watch_ctx(&flush_own_writes, &settings, &tombstones)),
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

        mod pairing {
            use super::*;
            use crate::rename_pairing::TOMBSTONE_TTL;

            struct StaticVault {
                state: AppState,
                vault: Vault,
            }

            async fn static_vault(dir: &TempDir, seed: &[&str]) -> StaticVault {
                let vault = Vault::open(dir.path()).await.expect("vault open");
                for rel in seed {
                    apply_watch_events_batch(&vault, &[WatchEvent::Created(rel.to_string())], None)
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
                state.vaults().write().await.insert(VAULT_ID.into(), open);
                StaticVault { state, vault }
            }

            async fn clear_inode(vault: &Vault, path: &str) {
                vault
                    .index()
                    .connection()
                    .execute(
                        "UPDATE files SET inode = NULL WHERE path = ?1",
                        params![path],
                    )
                    .await
                    .expect("clear inode");
            }

            async fn feed(live: &StaticVault, events: &[WatchEvent], tombstones: &Tombstones) {
                let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
                let settings = RwLock::new(SettingsMap::new());
                let ctx = watch_ctx(&flush_own_writes, &settings, tombstones);
                for ev in events {
                    apply_watch_event_to_db(&live.vault, ev, Some(&ctx)).await;
                }
            }

            #[cfg(unix)]
            #[tokio::test]
            async fn split_removed_then_created_pairs_on_inode_even_when_the_hash_is_ambiguous() {
                let dir = tempdir().unwrap();
                std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
                std::fs::write(dir.path().join("Twin.md"), "# Daily\n").unwrap();
                std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
                let live = static_vault(&dir, &["Daily.md", "Twin.md", "Project.md"]).await;

                std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md"))
                    .unwrap();

                let tombstones = new_tombstones();
                feed(
                    &live,
                    &[
                        WatchEvent::Removed("Daily.md".into()),
                        WatchEvent::Created("Journal.md".into()),
                    ],
                    &tombstones,
                )
                .await;

                let entries = read_entries(live.vault.root());
                assert_eq!(
                    entries.len(),
                    1,
                    "a split removal and creation of the same inode is one adopted rename \
                     (entries: {entries:?})",
                );
                assert_eq!(entries[0].from, "Daily.md");
                assert_eq!(entries[0].to, "Journal.md");
                assert!(file_row_exists(&live.vault, "Journal.md").await);
                assert!(!file_row_exists(&live.vault, "Daily.md").await);

                flush(&live.state).await;
                assert_eq!(
                    std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                    "see [[Journal]] today\n",
                    "the referrer is rewritten even though a duplicate blocks hash pairing",
                );
            }

            #[tokio::test]
            async fn split_removed_then_created_pairs_on_hash_when_the_inode_is_unavailable() {
                let dir = tempdir().unwrap();
                std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
                std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
                let live = static_vault(&dir, &["Daily.md", "Project.md"]).await;
                clear_inode(&live.vault, "Daily.md").await;

                std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md"))
                    .unwrap();

                let tombstones = new_tombstones();
                feed(
                    &live,
                    &[
                        WatchEvent::Removed("Daily.md".into()),
                        WatchEvent::Created("Journal.md".into()),
                    ],
                    &tombstones,
                )
                .await;

                let entries = read_entries(live.vault.root());
                assert_eq!(
                    entries.len(),
                    1,
                    "an unambiguous content hash pairs a cross-volume style move \
                     (entries: {entries:?})",
                );
                assert_eq!(entries[0].from, "Daily.md");
                assert_eq!(entries[0].to, "Journal.md");

                flush(&live.state).await;
                assert_eq!(
                    std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                    "see [[Journal]] today\n",
                );
            }

            #[tokio::test]
            async fn an_ambiguous_content_hash_is_never_paired() {
                let dir = tempdir().unwrap();
                std::fs::write(dir.path().join("Dup1.md"), "shared body\n").unwrap();
                std::fs::write(dir.path().join("Dup2.md"), "shared body\n").unwrap();
                std::fs::write(dir.path().join("Project.md"), "see [[Dup1]] today\n").unwrap();
                let live = static_vault(&dir, &["Dup1.md", "Dup2.md", "Project.md"]).await;
                clear_inode(&live.vault, "Dup1.md").await;
                clear_inode(&live.vault, "Dup2.md").await;

                std::fs::remove_file(dir.path().join("Dup1.md")).unwrap();
                std::fs::write(dir.path().join("Third.md"), "shared body\n").unwrap();

                let tombstones = new_tombstones();
                feed(
                    &live,
                    &[
                        WatchEvent::Removed("Dup1.md".into()),
                        WatchEvent::Created("Third.md".into()),
                    ],
                    &tombstones,
                )
                .await;

                assert!(
                    read_entries(live.vault.root()).is_empty(),
                    "a hash shared by several tracked files must never pair a rename",
                );
                assert!(
                    cubical_index::pending_for_target(live.vault.index(), "Project.md")
                        .await
                        .unwrap()
                        .is_empty(),
                    "no rewrite may be queued for an ambiguous pairing",
                );
                assert!(!file_row_exists(&live.vault, "Dup1.md").await);
                assert!(file_row_exists(&live.vault, "Third.md").await);

                flush(&live.state).await;
                assert_eq!(
                    std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                    "see [[Dup1]] today\n",
                    "the user's markdown is left untouched when the pairing is ambiguous",
                );
            }

            #[tokio::test]
            async fn a_created_after_the_tombstone_ttl_leaves_the_removal_standing() {
                let dir = tempdir().unwrap();
                std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
                std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
                let live = static_vault(&dir, &["Daily.md", "Project.md"]).await;
                clear_inode(&live.vault, "Daily.md").await;

                std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md"))
                    .unwrap();

                let tombstones = new_tombstones();
                feed(
                    &live,
                    &[WatchEvent::Removed("Daily.md".into())],
                    &tombstones,
                )
                .await;
                tokio::time::sleep(TOMBSTONE_TTL + Duration::from_millis(250)).await;
                feed(
                    &live,
                    &[WatchEvent::Created("Journal.md".into())],
                    &tombstones,
                )
                .await;

                assert!(
                    read_entries(live.vault.root()).is_empty(),
                    "an expired tombstone must not be resurrected into a rename",
                );
                assert!(!file_row_exists(&live.vault, "Daily.md").await);
                assert!(file_row_exists(&live.vault, "Journal.md").await);

                flush(&live.state).await;
                assert_eq!(
                    std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                    "see [[Daily]] today\n",
                    "the removal stands and the link is left dangling for the integrity view",
                );
            }

            #[cfg(unix)]
            #[tokio::test]
            async fn a_bare_created_with_a_dropped_source_is_paired_by_inode() {
                let dir = tempdir().unwrap();
                std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
                std::fs::write(dir.path().join("Project.md"), "see [[Daily]] today\n").unwrap();
                let live = static_vault(&dir, &["Daily.md", "Project.md"]).await;

                std::fs::rename(dir.path().join("Daily.md"), dir.path().join("Journal.md"))
                    .unwrap();

                let tombstones = new_tombstones();
                feed(
                    &live,
                    &[WatchEvent::Created("Journal.md".into())],
                    &tombstones,
                )
                .await;

                let entries = read_entries(live.vault.root());
                assert_eq!(
                    entries.len(),
                    1,
                    "a bare Created whose inode is still tracked at a vanished path is adopted \
                     (entries: {entries:?})",
                );
                assert_eq!(entries[0].from, "Daily.md");
                assert_eq!(entries[0].to, "Journal.md");
                assert!(file_row_exists(&live.vault, "Journal.md").await);
                assert!(!file_row_exists(&live.vault, "Daily.md").await);

                flush(&live.state).await;
                assert_eq!(
                    std::fs::read_to_string(dir.path().join("Project.md")).unwrap(),
                    "see [[Journal]] today\n",
                    "the dropped-source case still rewrites referrers",
                );
            }

            #[tokio::test]
            async fn an_ordinary_new_file_is_not_paired_with_anything() {
                let dir = tempdir().unwrap();
                std::fs::write(dir.path().join("Daily.md"), "# Daily\n").unwrap();
                let live = static_vault(&dir, &["Daily.md"]).await;

                std::fs::write(dir.path().join("Fresh.md"), "# Fresh\n").unwrap();
                let tombstones = new_tombstones();
                feed(
                    &live,
                    &[WatchEvent::Created("Fresh.md".into())],
                    &tombstones,
                )
                .await;

                assert!(
                    read_entries(live.vault.root()).is_empty(),
                    "creating a file next to an untouched vault is not a rename",
                );
                assert!(file_row_exists(&live.vault, "Daily.md").await);
                assert!(file_row_exists(&live.vault, "Fresh.md").await);
            }
        }

        #[tokio::test]
        async fn folder_rename_is_not_adopted() {
            let dir = tempdir().unwrap();
            std::fs::create_dir(dir.path().join("notes")).unwrap();
            let vault = Vault::open(dir.path()).await.expect("vault open");
            apply_watch_event_to_db(&vault, &WatchEvent::Created("notes".into()), None).await;
            std::fs::rename(dir.path().join("notes"), dir.path().join("archive")).unwrap();

            let flush_own_writes: FlushOwnWrites = Arc::new(Mutex::new(HashSet::new()));
            let settings = RwLock::new(SettingsMap::new());
            let tombstones = new_tombstones();
            apply_watch_event_to_db(
                &vault,
                &WatchEvent::Renamed {
                    from: "notes".to_string(),
                    to: "archive".to_string(),
                },
                Some(&watch_ctx(&flush_own_writes, &settings, &tombstones)),
            )
            .await;

            assert!(
                read_entries(vault.root()).is_empty(),
                "folder renames stay out of scope for v1 adoption",
            );
        }
    }
}
