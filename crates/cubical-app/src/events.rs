//! Event names + payload types + emit helpers.
//!
//! This module is the **single chokepoint** for backend → frontend events.
//! Pure command handlers never call `app_handle.emit()` directly; they call
//! `emit_*` helpers here. If the event transport ever migrates, only this
//! file changes.
//!
//! See `docs/migration-touchpoints.md`.

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{mpsc, RwLock};

use cubical_core::{refresh_frontmatter, scan, ScanProgress, Vault, VaultError, WatchEvent};
use libsql::params;
use tokio_util::sync::CancellationToken;

use crate::state::{OpenVault, ScanStatusBackend};

/// Re-export so pure command handlers can refer to `AppHandle` without
/// importing `tauri` directly. The "no `use tauri` in commands/" rule is
/// about migration touchpoints, not about avoiding the Tauri type itself
/// — `events.rs` is the single chokepoint where Tauri types are named.
pub use tauri::AppHandle;

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

        let new_status = match scan_outcome {
            Ok(Ok(file_count)) => {
                emit_scan_complete(
                    &app,
                    VaultScanComplete {
                        vault_id: vault_id.clone(),
                        file_count,
                        duration_ms: elapsed_ms,
                    },
                );
                ScanStatusBackend::Complete
            }
            Ok(Err(VaultError::ScanCancelled)) => {
                emit_scan_cancelled(
                    &app,
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                ScanStatusBackend::Cancelled
            }
            Ok(Err(e)) => {
                tracing::error!(error = %e, vault_id = %vault_id, "scan failed");
                emit_scan_cancelled(
                    &app,
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                ScanStatusBackend::Cancelled
            }
            Err(join_err) => {
                tracing::error!(error = %join_err, vault_id = %vault_id, "scan task join failed");
                emit_scan_cancelled(
                    &app,
                    VaultScanCancelled {
                        vault_id: vault_id.clone(),
                    },
                );
                ScanStatusBackend::Cancelled
            }
        };

        let mut guard = state.write().await;
        if let Some(open) = guard.get_mut(&vault_id) {
            open.scan_status = new_status;
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
) {
    tokio::spawn(async move {
        while let Some(ev) = events_rx.recv().await {
            let arrived = Instant::now();
            handle_watch_event(&app, &vault_id, &vault, &ev, arrived).await;
        }
        tracing::debug!(vault_id = %vault_id, "watcher dispatcher: channel closed");
    });
}

async fn handle_watch_event(
    app: &AppHandle,
    vault_id: &str,
    vault: &Vault,
    ev: &WatchEvent,
    arrived: Instant,
) {
    let new_content_hash = apply_watch_event_to_db(vault, ev).await;

    let payload = file_changed_payload(vault_id, ev, new_content_hash);
    let elapsed_ms = arrived.elapsed().as_millis();
    tracing::info!(
        vault_id = %vault_id,
        kind = ?payload.kind,
        path = %payload.path,
        elapsed_ms,
        "watcher: emitting vault:file-changed",
    );
    emit_file_changed(app, payload);
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
            if type_id == "markdown" {
                if let Err(e) = refresh_frontmatter(vault, &abs, &path_str).await {
                    tracing::warn!(path = %path_str, error = %e, "watcher: frontmatter refresh failed");
                }
            }

            if hash.is_empty() {
                None
            } else {
                Some(hash)
            }
        }
        WatchEvent::Removed(rel) => {
            // Row stays — refresh `last_seen` only. L3 cleanup work
            // will reconcile path-keyed identity properly; deleting
            // here would orphan future block refs that still point at
            // the old path. Spec §6 calls for `last_seen` refresh.
            let path_str = rel.to_string_lossy().into_owned();
            if let Err(e) = conn
                .execute(
                    "UPDATE files SET last_seen = ?1 WHERE path = ?2",
                    params![now, path_str.clone()],
                )
                .await
            {
                tracing::warn!(path = %path_str, error = %e, "watcher: files last_seen update failed");
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

    new_content_hash
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
}
