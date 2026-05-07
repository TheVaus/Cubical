//! Request and response types for IPC commands.
//!
//! Plain `serde` structs — no Tauri imports, no Tauri-specific decorators.
//! These cross the Lane 1 ↔ Lane 2 boundary and survive a future shell
//! migration unchanged.
//!
//! See `docs/layer-0-spec.md` §8.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Status of a vault's initial scan at the moment a command observed it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    /// The scan task is still running.
    InProgress,
    /// The scan task has finished — `files` reflects the full vault contents.
    Complete,
    /// The scan was cancelled before finishing.
    Cancelled,
}

// -- open_vault ----------------------------------------------------------

/// Request payload for `open_vault`.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenVaultRequest {
    /// Absolute path to the directory the user picked.
    pub path: PathBuf,
}

/// Response payload for `open_vault`.
#[derive(Debug, Clone, Serialize)]
pub struct OpenVaultResponse {
    /// Session-scoped handle the frontend uses to refer to this vault.
    pub vault_id: String,
    /// Status of the initial scan at the moment the response was built.
    pub scan_status: ScanStatus,
}

// -- cancel_vault_scan ---------------------------------------------------

/// Request payload for `cancel_vault_scan`.
#[derive(Debug, Clone, Deserialize)]
pub struct CancelVaultScanRequest {
    /// Vault whose scan should be cancelled.
    pub vault_id: String,
}

// -- get_vault_info ------------------------------------------------------

/// Request payload for `get_vault_info`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetVaultInfoRequest {
    /// Vault to query.
    pub vault_id: String,
}

/// Response payload for `get_vault_info`.
#[derive(Debug, Clone, Serialize)]
pub struct GetVaultInfoResponse {
    /// Absolute path the vault was opened against.
    pub path: PathBuf,
    /// Number of files currently tracked in the index. Reflects what the
    /// scan has discovered so far if the scan is still running.
    pub file_count: u32,
    /// Subset of `file_count` with `type_id = "markdown"`.
    pub markdown_count: u32,
    /// Subset of `file_count` with `type_id = "binary"`.
    pub binary_count: u32,
    /// Schema version on disk.
    pub schema_version: u32,
    /// Status of the initial scan at the moment the query was answered.
    pub scan_status: ScanStatus,
}

// -- list_files ----------------------------------------------------------

/// Request payload for `list_files`.
#[derive(Debug, Clone, Deserialize)]
pub struct ListFilesRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Optional pagination cap — defaults to `u32::MAX` (return everything).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Optional pagination offset — defaults to 0.
    #[serde(default)]
    pub offset: Option<u32>,
}

/// Response payload for `list_files`.
#[derive(Debug, Clone, Serialize)]
pub struct ListFilesResponse {
    /// Files discovered so far. May be a partial view if the scan is still in progress.
    pub files: Vec<FileEntry>,
    /// Total count of files in the index (independent of `limit`/`offset`).
    pub total: u32,
}

/// Per-file row returned by `list_files`.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    /// Path relative to the vault root.
    pub path: String,
    /// Stable file-type handler id (`"markdown"`, `"binary"`, ...).
    pub type_id: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Unix mtime in seconds.
    pub mtime_unix: i64,
}

// -- close_vault ---------------------------------------------------------

/// Request payload for `close_vault`.
#[derive(Debug, Clone, Deserialize)]
pub struct CloseVaultRequest {
    /// Vault to close.
    pub vault_id: String,
}
