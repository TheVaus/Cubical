//! Event names + payload types + emit helpers.
//!
//! This module is the **single chokepoint** for backend → frontend events.
//! Pure command handlers never call `app_handle.emit()` directly; they call
//! `emit_*` helpers here. If the event transport ever migrates, only this
//! file changes.
//!
//! See `docs/migration-touchpoints.md`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

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
