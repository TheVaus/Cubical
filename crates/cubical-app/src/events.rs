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

use cubical_core::{scan, ScanProgress, Vault, VaultError};
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
}

/// Discriminator for [`VaultFileChanged`].
#[derive(Serialize, Clone)]
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
