//! Event names + payload types + emit helpers.
//!
//! This module is the **single chokepoint** for backend → frontend events.
//! Pure command handlers never call `app_handle.emit()` directly; they call
//! `emit_*` helpers here. If the event transport ever migrates, only this
//! file changes.
//!
//! See `docs/migration-touchpoints.md`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex, RwLock};

use cubical_core::vault::links::read_source_off_executor;
use cubical_core::vault::pending::materialize_on_read;
use cubical_core::{
    refresh_block_refs_for_file, refresh_blocks, refresh_frontmatter, refresh_links, refresh_tags,
    scan, ScanProgress, Vault, VaultError, WatchEvent,
};
use libsql::params;
use tokio_util::sync::CancellationToken;

use crate::state::{OpenVault, ScanStatusBackend};

/// Per-vault own-write hash gate consumed by the watcher dispatcher.
///
/// The flush executor inserts `(relative_path, content_hash_hex)` BEFORE
/// the atomic write; the watcher dispatcher's `Modified` branch, after
/// computing the post-write disk hash, removes the matching entry and
/// suppresses the `vault:file-changed` emit. This is the backend mirror
/// of L2's editor-side hash gate — flush writes have no editor to
/// match them, so they would otherwise bounce back into the UI as
/// external edits and re-trigger reads.
pub type FlushOwnWrites = Arc<Mutex<HashSet<(PathBuf, String)>>>;

/// Re-export so pure command handlers can refer to `AppHandle` without
/// importing `tauri` directly. The "no `use tauri` in commands/" rule is
/// about migration touchpoints, not about avoiding the Tauri type itself
/// — `events.rs` is the single chokepoint where Tauri types are named.
pub use tauri::AppHandle;
/// Re-export the `Runtime` bound used by the L3 Session J emit helpers
/// and handlers. Runtime-generic signatures let the same code run
/// against the production `Wry` runtime AND `tauri::test::MockRuntime`
/// in unit tests.
pub use tauri::Runtime;

// -- Event name constants ---------------------------------------------------
//
// One constant per event. No string literals scattered across the codebase.

/// Streamed during a vault scan; payload counts converge as the scan progresses.
pub const VAULT_SCAN_PROGRESS: &str = "vault:scan-progress";

/// Emitted exactly once per vault open when its initial scan finishes.
pub const VAULT_SCAN_COMPLETE: &str = "vault:scan-complete";

/// Emitted if a scan was cancelled before completion (e.g., vault closed mid-scan).
pub const VAULT_SCAN_CANCELLED: &str = "vault:scan-cancelled";

/// Emitted whenever the file watcher reports a change in the vault.
pub const VAULT_FILE_CHANGED: &str = "vault:file-changed";

/// L3 Session J — emitted whenever the pending-rewrites total for a
/// vault changes (enqueue from a rename, drain from a flush, undo). The
/// payload carries the new count so the status-bar item updates in one
/// hop without a follow-up `get_pending_rewrites_count` round trip.
pub const VAULT_PENDING_REWRITES_CHANGED: &str = "vault:pending-rewrites-changed";

/// L3 Session J — emitted exactly once at the end of a flush, carrying
/// per-flush totals. Drives the post-flush toast in J.2.
pub const VAULT_FLUSH_COMPLETE: &str = "vault:flush-complete";

/// Live tail of the audit log, useful for in-app debugging UIs.
pub const VAULT_AUDIT: &str = "vault:audit";

// -- Payload structs --------------------------------------------------------

/// Payload for [`VAULT_SCAN_PROGRESS`].
#[derive(Serialize, Clone)]
pub struct VaultScanProgress {
    pub vault_id: String,
    pub files_processed: u32,
    pub files_total_estimate: u32,
}

/// Payload for [`VAULT_SCAN_COMPLETE`].
#[derive(Serialize, Clone)]
pub struct VaultScanComplete {
    pub vault_id: String,
    pub file_count: u32,
    pub duration_ms: u64,
}

/// Payload for [`VAULT_SCAN_CANCELLED`].
#[derive(Serialize, Clone)]
pub struct VaultScanCancelled {
    pub vault_id: String,
}

/// Payload for [`VAULT_FILE_CHANGED`].
#[derive(Serialize, Clone)]
pub struct VaultFileChanged {
    pub vault_id: String,
    pub path: String,
    pub kind: VaultFileChangeKind,
    /// Set only when `kind == Renamed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
    /// Content hash of the file after the watcher processed the event.
    /// Set for `Created` and `Modified`; `None` for `Removed` and
    /// `Renamed`. Used by L2's hash-gating to suppress the editor's
    /// own-write echoes (see `docs/layer-2-spec.md` §2.8) and by L2's
    /// external-edit conflict detection (§2.7).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_content_hash: Option<String>,
}

/// Discriminator for [`VaultFileChanged`].
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum VaultFileChangeKind {
    Created,
    Modified,
    Removed,
    Renamed,
}

/// Payload for [`VAULT_AUDIT`].
#[derive(Serialize, Clone)]
pub struct VaultAudit {
    pub level: String,
    pub category: String,
    pub message: String,
}

/// Payload for [`VAULT_PENDING_REWRITES_CHANGED`].
#[derive(Serialize, Clone)]
pub struct VaultPendingRewritesChanged {
    pub vault_id: String,
    pub count: i64,
}

/// Payload for [`VAULT_FLUSH_COMPLETE`].
#[derive(Serialize, Clone)]
pub struct VaultFlushComplete {
    pub vault_id: String,
    pub files_rewritten: i64,
    pub refs_updated: i64,
}

// -- Emit helpers -----------------------------------------------------------
//
// Generic over `AppHandle` so pure handlers can be tested with a mock or
// no-op emitter in unit tests. Production code passes the real `AppHandle`.

/// Emit a [`VAULT_SCAN_PROGRESS`] event. Logs and ignores transport errors.
pub fn emit_scan_progress(app: &AppHandle, payload: VaultScanProgress) {
    if let Err(e) = app.emit(VAULT_SCAN_PROGRESS, payload) {
        tracing::warn!(error = %e, "failed to emit scan-progress");
    }
}

/// Emit a [`VAULT_SCAN_COMPLETE`] event.
pub fn emit_scan_complete(app: &AppHandle, payload: VaultScanComplete) {
    if let Err(e) = app.emit(VAULT_SCAN_COMPLETE, payload) {
        tracing::warn!(error = %e, "failed to emit scan-complete");
    }
}

/// Emit a [`VAULT_SCAN_CANCELLED`] event.
pub fn emit_scan_cancelled(app: &AppHandle, payload: VaultScanCancelled) {
    if let Err(e) = app.emit(VAULT_SCAN_CANCELLED, payload) {
        tracing::warn!(error = %e, "failed to emit scan-cancelled");
    }
}

/// Emit a [`VAULT_FILE_CHANGED`] event.
pub fn emit_file_changed(app: &AppHandle, payload: VaultFileChanged) {
    if let Err(e) = app.emit(VAULT_FILE_CHANGED, payload) {
        tracing::warn!(error = %e, "failed to emit file-changed");
    }
}

/// Emit a [`VAULT_AUDIT`] event.
pub fn emit_audit(app: &AppHandle, payload: VaultAudit) {
    if let Err(e) = app.emit(VAULT_AUDIT, payload) {
        tracing::warn!(error = %e, "failed to emit audit");
    }
}

/// Emit a [`VAULT_PENDING_REWRITES_CHANGED`] event. Runtime-generic so
/// unit tests can pass `tauri::test::MockRuntime` handles.
pub fn emit_pending_rewrites_changed<R: Runtime>(
    app: &tauri::AppHandle<R>,
    payload: VaultPendingRewritesChanged,
) {
    if let Err(e) = app.emit(VAULT_PENDING_REWRITES_CHANGED, payload) {
        tracing::warn!(error = %e, "failed to emit pending-rewrites-changed");
    }
}

/// Emit a [`VAULT_FLUSH_COMPLETE`] event. Runtime-generic for the same
/// reason as [`emit_pending_rewrites_changed`].
pub fn emit_flush_complete<R: Runtime>(app: &tauri::AppHandle<R>, payload: VaultFlushComplete) {
    if let Err(e) = app.emit(VAULT_FLUSH_COMPLETE, payload) {
        tracing::warn!(error = %e, "failed to emit flush-complete");
    }
}

// -- Scan dispatcher --------------------------------------------------------
//
// Spawned by `commands::vault::open_vault`. Owns the scan task, forwards
// `ScanProgress` updates from the scan's mpsc into Tauri events, and
// emits the terminal event (complete / cancelled) when the scan ends.
// Lives here because it touches `AppHandle` and the emit helpers; the
// pure command handler stays Tauri-free by calling
// [`spawn_scan_dispatcher`] and walking away.

/// Spawn the dispatcher task that drives a scan to completion.
///
/// Returns immediately. The dispatcher:
/// 1. Spawns the actual scan via [`cubical_core::scan`].
/// 2. Forwards every [`ScanProgress`] from the scan's channel into a
///    [`VaultScanProgress`] Tauri event.
/// 3. When the scan terminates, emits exactly one of
///    [`VaultScanComplete`] or [`VaultScanCancelled`] and updates the
///    `OpenVault.scan_status` field in shared state so subsequent
///    `get_vault_info` queries see the new state.
pub fn spawn_scan_dispatcher(
    app: AppHandle,
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
        let app_for_progress = app.clone();
        let progress_pump = tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                emit_scan_progress(
                    &app_for_progress,
                    VaultScanProgress {
                        vault_id: vid_for_progress.clone(),
                        files_processed: p.files_processed,
                        files_total_estimate: p.files_total_estimate,
                    },
                );
            }
        });

        let scan_outcome = scan_handle.await;
        // The scan task has returned (success, cancellation, or panic),
        // which means the sender side of the progress channel is dropped
        // and the pump will see end-of-stream and exit.
        let _ = progress_pump.await;

        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let (new_status, new_search_state) = match scan_outcome {
            Ok(Ok(file_count)) => {
                // Replay the rename-durability journal now that the scan
                // has resolved links: reconnect any referrers stranded by
                // a rename whose index state was wiped before flush
                // (design 2026-06-27). Best-effort, before announcing
                // scan-complete so clients see reconnected links.
                crate::commands::rename::replay_rename_journal(&vault, &app, &vault_id).await;
                emit_scan_complete(
                    &app,
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
                    &app,
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                // Cancellation leaves the index in whatever shape the scan
                // reached. Mark as `Error` so polling clients know the
                // index is not authoritatively up to date — a follow-up
                // rebuild or close+reopen is the way to recover.
                (
                    ScanStatusBackend::Cancelled,
                    cubical_search::IndexState::Error,
                )
            }
            Ok(Err(e)) => {
                tracing::error!(error = %e, vault_id = %vault_id, "scan failed");
                emit_scan_cancelled(
                    &app,
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
                    &app,
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

// -- Watcher dispatcher -----------------------------------------------------
//
// Spawned by `commands::vault::open_vault` after `start_watcher`. Owns the
// receiver end of the watcher mpsc, persists each event to the `files`
// table + `audit_log`, and emits `vault:file-changed`. Lives here for
// the same reason `spawn_scan_dispatcher` does: the pure command handler
// stays Tauri-free.

/// Spawn the dispatcher task that consumes [`WatchEvent`]s.
///
/// Each event:
/// 1. Updates the `files` table (`Created` / `Modified` refresh
///    `mtime_unix` + `content_hash` + `last_seen`; `Removed` and
///    `Renamed` refresh `last_seen` only — row-level deletion / path
///    update are L1+ work, see `docs/layer-0-spec.md` §6 + §3).
/// 2. Inserts a row into `audit_log` (`category = 'watcher'`).
/// 3. Emits a `vault:file-changed` Tauri event.
///
/// Errors are logged and the loop continues — a single failed event
/// must not take the watcher down.
pub fn spawn_watcher_dispatcher(
    app: AppHandle,
    vault_id: String,
    vault: Vault,
    mut events_rx: tokio::sync::mpsc::Receiver<WatchEvent>,
    flush_own_writes: FlushOwnWrites,
) {
    tokio::spawn(async move {
        while let Some(first) = events_rx.recv().await {
            // Drain everything already queued so a burst of writes — a
            // rename flushing thousands of backlinks, or an external bulk
            // edit — is processed as one batch with a single search
            // commit, instead of one commit per file.
            let mut batch = vec![first];
            while let Ok(next) = events_rx.try_recv() {
                batch.push(next);
            }
            handle_watch_batch(&app, &vault_id, &vault, batch, &flush_own_writes).await;
        }
        tracing::debug!(vault_id = %vault_id, "watcher dispatcher: channel closed");
    });
}

async fn handle_watch_batch(
    app: &AppHandle,
    vault_id: &str,
    vault: &Vault,
    batch: Vec<WatchEvent>,
    flush_own_writes: &FlushOwnWrites,
) {
    let arrived = Instant::now();

    // Apply every event's DB + index writes, then commit the search index
    // once for the whole batch.
    let hashes = apply_watch_events_batch(vault, &batch).await;

    // Emit `vault:file-changed` AFTER the commit: the reader uses
    // `ReloadPolicy::Manual`, so the UI's file-changed re-query only sees
    // committed docs. Own-writes are suppressed — their bytes are already
    // indexed, but the editor that produced them needs no echo.
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
        emit_file_changed(app, payload);
    }
}

/// Apply one watcher event to the index — the `files` row plus an
/// `audit_log` insert.
///
/// Pulled out of [`handle_watch_event`] so it can be unit-tested without
/// an `AppHandle`. Returns the file's content hash post-update for
/// `Created`/`Modified` events (so the caller can put it on the emitted
/// payload — see L2 spec §3.5); returns `None` for `Removed`/`Renamed`
/// and for the degenerate hash-failed case. Errors are logged and
/// swallowed: a bad write should not take the dispatcher down.
pub(crate) async fn apply_watch_event_to_db(vault: &Vault, ev: &WatchEvent) -> Option<String> {
    let now = unix_now_secs();
    let conn = vault.index().connection();

    // Directory `Created`/`Modified` → record it in `folders` and skip
    // all file-oriented extraction (a dir has no content/hash/links). The
    // caller still emits `vault:file-changed`, so the tree refetches and
    // the new folder appears. (`Removed` is handled in the match below:
    // the path is already gone from disk and can't be stat'd as a dir.)
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

    // -- Update files row -------------------------------------------------
    let new_content_hash = match ev {
        WatchEvent::Created(rel) | WatchEvent::Modified(rel) => {
            let abs = vault.root().join(rel);
            let path_str = rel.to_string_lossy().into_owned();
            // None case (file already gone, unreadable, or hash failed):
            // upsert with zeros + empty hash, but still audit + emit so
            // the UI refreshes. The next scan or modify event will heal
            // the row.
            let (size, mtime, hash): (i64, i64, String) =
                read_file_stats(&abs, vault).await.unwrap_or_default();
            // type_id is derived from the registry; if no handler
            // matches (impossible with the default registry) skip.
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
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6, ?6)
                ON CONFLICT(path) DO UPDATE SET
                    size_bytes   = excluded.size_bytes,
                    mtime_unix   = excluded.mtime_unix,
                    content_hash = excluded.content_hash,
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
                        now
                    ],
                )
                .await
            {
                tracing::warn!(path = %path_str, error = %e, "watcher: files upsert failed");
            }

            // L1: refresh `frontmatter` rows for markdown files. Best
            // effort — a malformed YAML or transient I/O error here
            // must not take the dispatcher down. Non-markdown types
            // skip; frontmatter is a markdown-only concept.
            //
            // L3 Session J (chain 3): read the source ONCE for this
            // markdown file and materialize any pending rewrites for
            // `path_str`, then hand the materialized text to every
            // extractor. (`hash` above stays raw — that's
            // `files.content_hash`, which tracks on-disk bytes for
            // change detection, NOT the rewritten view.)
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
                // L3: refresh `links` rows. Best effort — same policy
                // as frontmatter; a read or SQL failure must not take
                // the dispatcher down. Removed/Renamed events skip:
                // `Removed` leaves the row alone (FK cascade will fire
                // when the eventual cleanup-rewrite session ships);
                // `Renamed` is handled by the future pending-rewrites
                // work along with the rest of the rename pipeline.
                if let Err(e) = refresh_links(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: links refresh failed");
                }
                // L3 Session D: refresh `tags` rows. Same best-effort
                // policy as links + frontmatter.
                if let Err(e) = refresh_tags(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: tags refresh failed");
                }
                // L3 §2.7: refresh block-id definitions, then re-derive
                // this file's block_refs from its just-written links.
                if let Err(e) = refresh_blocks(vault, &path_str, &source).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: blocks refresh failed");
                }
                if let Err(e) = refresh_block_refs_for_file(vault, &path_str).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: block_refs refresh failed");
                }
                // L4-A: keep the Tantivy index in sync with create/modify
                // events. Same best-effort policy as the libSQL refreshers
                // — log on error, do not take the dispatcher down. Caller
                // commits the SearchIndex once at the end of this
                // dispatcher invocation (per-event the watcher is already
                // debounced upstream).
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
            // The file is gone from disk — drop its `files` row so it
            // stops surfacing in the tree / `list_files`. The
            // `ON DELETE CASCADE` FKs on `frontmatter`, `links`, `tags`,
            // `blocks`, and `block_refs` (keyed on the owning/source
            // path) carry this file's OUTBOUND rows with it. INBOUND
            // references (other files' `links.target_path` /
            // `block_refs.target_file_path`, which have no FK) are left
            // intact so they correctly degrade to broken links.
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
            // The removed path could have been a directory rather than a
            // file (it's gone now, so we can't tell which) — drop any
            // matching `folders` row too. No-op when it was a file.
            if let Err(e) = cubical_index::delete_folder(vault.index(), &path_str).await {
                tracing::warn!(path = %path_str, error = %e, "watcher: folder row delete failed");
            }
            // L4-A: remove the file from the Tantivy index. The libSQL
            // `files` row sticks around (see above) but the search doc
            // should not — stale snippets pointing at a deleted file
            // would break ranking + click-through.
            if let Err(e) =
                cubical_core::vault::search_refresh::delete_search_index(vault, &path_str).await
            {
                tracing::warn!(path = %path_str, error = %e, "watcher: search delete failed");
            }
            None
        }
        WatchEvent::Renamed { from, to: _ } => {
            // Path-keyed identity update is non-trivial: a row rename
            // would orphan any future `wiki_links` / `block_refs`
            // pointing at the old path. Defer to L3's pending-rewrites
            // work. For now: refresh `last_seen` on the old row, emit
            // the event, and audit-log it. The next vault scan will
            // observe the new path as a fresh row.
            let from_str = from.to_string_lossy().into_owned();
            if let Err(e) = conn
                .execute(
                    "UPDATE files SET last_seen = ?1 WHERE path = ?2",
                    params![now, from_str.clone()],
                )
                .await
            {
                tracing::warn!(path = %from_str, error = %e, "watcher: rename last_seen update failed");
            }
            // L4-A: drop the old path's search doc. The new path will
            // be re-indexed via the paired Created/Modified event the
            // watcher emits on a rename (same convergence the L3
            // refreshers rely on). Upsert is idempotent so a follow-up
            // Modified is the right ownership boundary for the new doc.
            if let Err(e) =
                cubical_core::vault::search_refresh::delete_search_index(vault, &from_str).await
            {
                tracing::warn!(path = %from_str, error = %e, "watcher: search delete (rename old) failed");
            }
            None
        }
    };

    // -- Audit log ---------------------------------------------------------
    let (message, detail) = audit_payload_for(ev);
    if let Err(e) = conn
        .execute(
            "INSERT INTO audit_log (timestamp, level, category, message, detail)
             VALUES (?1, 'info', 'watcher', ?2, ?3)",
            params![now, message, detail],
        )
        .await
    {
        // TODO(L0+): auto-prune to 10000 rows per spec §7. Skipped for
        // now; the table grows unbounded until that lands.
        tracing::warn!(error = %e, "watcher: audit_log insert failed");
    }

    // NB: no `search().commit()` here. The dispatcher batches one commit
    // per drained burst of events (see `apply_watch_events_batch`). A bulk
    // rewrite — e.g. a rename flushing pending rewrites across thousands
    // of backlinks — fires one watch event per file; committing per event
    // would do O(n) segment merges + fsyncs and dominated the operation.
    // This matches the "caller commits" contract the scan path
    // (`SEARCH_COMMIT_EVERY`) and `search_refresh` already follow.

    new_content_hash
}

/// Apply a drained burst of watch events to the index, then commit the
/// Tantivy index **once** for the whole batch. Returns each event's
/// post-update content hash (in input order) so the caller can run its
/// own-write gate + emit `vault:file-changed`.
///
/// This batching is the fix for the per-event-commit perf cliff: a
/// rename flushing thousands of backlinks fires one `Modified` event per
/// file, and a Tantivy commit (segment merge + fsync + GC) per file
/// turned a bulk flush into a multi-minute hang. One commit per drained
/// burst makes it O(1) commits instead of O(events).
pub(crate) async fn apply_watch_events_batch(
    vault: &Vault,
    events: &[WatchEvent],
) -> Vec<Option<String>> {
    let mut hashes = Vec::with_capacity(events.len());
    for ev in events {
        hashes.push(apply_watch_event_to_db(vault, ev).await);
    }
    // One commit for the whole burst — the reader reloads here, so every
    // doc in the batch becomes queryable together.
    if let Err(e) = vault.search().commit() {
        tracing::warn!(error = %e, "watcher: batch search commit failed");
    }
    hashes
}

/// Pull size/mtime/hash for an absolute path. Hashing happens off the
/// runtime via `spawn_blocking`, mirroring what `scan.rs` does for
/// large files.
async fn read_file_stats(abs: &std::path::Path, vault: &Vault) -> Option<(i64, i64, String)> {
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
    Some((size, mtime, hash))
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

/// L3 Session J — backend own-write hash gate consumer.
///
/// Returns `true` if the event matches an entry in `flush_own_writes`
/// (and the entry has been drained — own-write gate entries are
/// single-use). Only `Modified` events with a non-empty hash can match;
/// all other event kinds pass through.
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
    //! Tests for the watcher dispatcher's DB side. The Tauri-emit half
    //! is exercised by the smoke pass against `cargo tauri dev`; here
    //! we cover the audit-log row shape and the files-table updates,
    //! which are the parts that can regress silently.

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
            apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md"))).await;
        assert!(hash.is_some(), "Created on a real file returns its hash");

        // files row exists with type_id=markdown and a non-empty hash.
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

        // audit_log row exists with category=watcher and a JSON detail.
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

    #[tokio::test]
    async fn modified_event_refreshes_frontmatter_table() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: Old\n---\n\nbody\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        // Seed a Created event so the `files` row exists, then
        // overwrite the file and fire Modified.
        let h1 = apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md")))
            .await
            .expect("Created hash");
        std::fs::write(&p, "---\ntitle: New\nstatus: ready\n---\n\nbody\n").unwrap();
        let h2 = apply_watch_event_to_db(&vault, &WatchEvent::Modified(PathBuf::from("note.md")))
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
        // L3 Session J (chain 3): the watcher's Modified branch reads
        // the source ONCE per markdown file and materializes any pending
        // wiki-link rewrites before handing it to the link extractor.
        // CRITICAL: files.content_hash is computed against the RAW bytes
        // (its purpose is tracking on-disk state), NOT the materialized
        // view.
        use cubical_core::sha256_bytes_hex;
        use cubical_index::{enqueue_pending, links_from, NewPendingRewrite, RewriteKind};

        let dir = tempdir().unwrap();
        let p = dir.path().join("a.md");
        let raw = "linked to [[OldName]]\n";
        std::fs::write(&p, raw).unwrap();
        // Target file so the rewrite resolves to a real path.
        std::fs::write(dir.path().join("Daily.md"), "body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        // Seed a Created event so `files` rows exist for both paths.
        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("a.md"))).await;
        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("Daily.md"))).await;

        // Enqueue a pending rewrite for a.md: OldName → Daily.
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

        // Fire Modified. (File on disk unchanged; the watcher just
        // re-applies the extractors over the post-materialize view.)
        let hash = apply_watch_event_to_db(&vault, &WatchEvent::Modified(PathBuf::from("a.md")))
            .await
            .expect("Modified hash");

        // Extractor output: the link resolves to Daily.md, not OldName.
        let rows = links_from(vault.index(), "a.md").await.expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_raw, "Daily");
        assert_eq!(rows[0].target_path.as_deref(), Some("Daily.md"));

        // content_hash is over the RAW bytes (not the materialized view).
        assert_eq!(hash, sha256_bytes_hex(raw.as_bytes()));
        // And the file on disk is still raw.
        assert_eq!(std::fs::read_to_string(&p).unwrap(), raw);
    }

    #[tokio::test]
    async fn created_dir_event_records_folder_and_skips_files_table() {
        // A directory create must land in `folders`, not `files`.
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("projects")).unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("projects"))).await;
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
        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("projects"))).await;
        assert_eq!(
            cubical_index::list_folders(vault.index())
                .await
                .unwrap()
                .len(),
            1,
        );

        std::fs::remove_dir(dir.path().join("projects")).unwrap();
        apply_watch_event_to_db(&vault, &WatchEvent::Removed(PathBuf::from("projects"))).await;
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
        // Seed a row first so the UPDATE has something to touch.
        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md"))).await;

        let hash =
            apply_watch_event_to_db(&vault, &WatchEvent::Removed(PathBuf::from("note.md"))).await;
        assert!(hash.is_none(), "Removed must not carry a hash");
    }

    #[tokio::test]
    async fn removed_event_deletes_files_row_and_cascades_children() {
        // External delete (app open): the watcher's Removed branch must
        // DROP the `files` row so the file stops showing in the tree, and
        // the ON DELETE CASCADE FKs must carry its outbound frontmatter /
        // links / tags / blocks rows with it. Regression guard for the
        // "deleted file lingers in the file tree" bug.
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: Hi\n---\n\n#planning body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        // Created seeds the files row plus its outbound index rows.
        apply_watch_event_to_db(&vault, &WatchEvent::Created(PathBuf::from("note.md"))).await;
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

        // Now delete it on disk and fire Removed.
        std::fs::remove_file(&p).unwrap();
        apply_watch_event_to_db(&vault, &WatchEvent::Removed(PathBuf::from("note.md"))).await;

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
            // Even if a caller passes a hash for a Remove (it shouldn't),
            // we drop it — the wire shape is invariant on event kind.
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

        // Entry was single-use — a second pass through the gate sees an
        // empty set and lets the event through.
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

        // Same path, different hash — external edit landed on top of
        // the flush write before the watcher observed it. Must pass
        // through (the user sees the change) and the original entry
        // stays put (a subsequent identical-hash event would still be
        // suppressed).
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

    // ------------------------------------------------------------------
    // L4-A: watcher → Tantivy fan-out.
    //
    // `apply_watch_event_to_db` no longer commits (the dispatcher batches
    // one commit per drained burst), so these tests drive the index via
    // `apply_watch_events_batch`, which commits the batch once.

    #[tokio::test]
    async fn modified_event_refreshes_search_index() {
        // Modify a markdown file via the dispatcher, then run a search
        // and assert the new content is queryable. The Created event
        // seeds an empty body; the Modified event introduces a unique
        // token we can search for.
        use cubical_search::query::run_search;
        use cubical_search::{FieldScope, SearchQuery, SortMode};

        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "old body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("vault open");

        // Seed Created, then rewrite the file and fire Modified. Each
        // batch call commits once so both upserts land.
        apply_watch_events_batch(&vault, &[WatchEvent::Created(PathBuf::from("note.md"))]).await;
        std::fs::write(&p, "freshly indexed unicorn token\n").unwrap();
        apply_watch_events_batch(&vault, &[WatchEvent::Modified(PathBuf::from("note.md"))]).await;

        // doc_count should be exactly 1 (upsert is delete-by-path then
        // add, never duplicates).
        assert_eq!(vault.search().doc_count().unwrap(), 1);

        // The unique post-Modified token is queryable.
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

        // And the pre-Modified token is NOT queryable — upsert replaced
        // the doc, not appended to it.
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
        // Delete a file via the dispatcher, then assert doc_count drops
        // from 1 to 0. The libSQL `files` row stays (per the existing
        // Removed branch policy) but the search doc must go — no stale
        // results pointing at a deleted file.
        let (_dir, vault) = fresh_vault_with_one_md("gone.md").await;
        apply_watch_events_batch(&vault, &[WatchEvent::Created(PathBuf::from("gone.md"))]).await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            1,
            "Created should seed exactly one search doc",
        );

        apply_watch_events_batch(&vault, &[WatchEvent::Removed(PathBuf::from("gone.md"))]).await;
        assert_eq!(
            vault.search().doc_count().unwrap(),
            0,
            "Removed should drop the search doc",
        );
    }

    #[tokio::test]
    async fn renamed_event_drops_old_path_from_search_index() {
        // Rename = delete old in this dispatcher invocation. The new
        // path's doc lands via the paired Created/Modified event the
        // watcher emits next; we don't simulate it here — what matters
        // is that the OLD path is gone after the Renamed call.
        let (_dir, vault) = fresh_vault_with_one_md("a.md").await;
        apply_watch_events_batch(&vault, &[WatchEvent::Created(PathBuf::from("a.md"))]).await;
        assert_eq!(vault.search().doc_count().unwrap(), 1);

        apply_watch_events_batch(
            &vault,
            &[WatchEvent::Renamed {
                from: PathBuf::from("a.md"),
                to: PathBuf::from("b.md"),
            }],
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
        // Regression guard for the per-event-commit perf bug: a bulk
        // rewrite (a rename flushing thousands of backlinks) fires one
        // watch event per file. The dispatcher must commit the Tantivy
        // index ONCE for the whole drained batch — a commit per file does
        // O(n) segment merges + fsyncs and turned a big flush into a
        // multi-minute hang.
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
        apply_watch_events_batch(&vault, &events).await;
        let delta = vault.search().commit_count() - before;

        assert_eq!(
            delta, 1,
            "a batch of {n} events must commit exactly once (got {delta})"
        );
        // Functionality preserved: every file is indexed + queryable.
        assert_eq!(
            vault.search().doc_count().unwrap(),
            n as u64,
            "all batched docs must be searchable after the single commit",
        );
    }
}
