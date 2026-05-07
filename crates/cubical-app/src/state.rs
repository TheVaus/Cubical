//! Application state container.
//!
//! `AppState` is plain Rust — no Tauri imports. Tauri stores it via
//! `app.manage(state)`; pure command handlers in `crate::commands` take
//! `&AppState`. The Tauri shim in `lib.rs` is the only place that knows
//! how state is wrapped (`tauri::State<'_, AppState>`).
//!
//! See `docs/migration-touchpoints.md` for the rationale.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use cubical_core::Vault;

/// One open vault, including its scan lifecycle handles.
///
/// `cancel` is the trigger for `cancel_vault_scan` and `close_vault`. The
/// scan dispatcher task drives the scan to completion and emits the
/// terminal Tauri event; we don't store the JoinHandle here because the
/// dispatcher detaches once started — `cancel` is sufficient to bring it
/// down responsively.
pub struct OpenVault {
    /// The opened vault — cheap to clone for sharing with the scan task.
    pub vault: Vault,
    /// Cancellation handle for the active scan. Firing this brings the
    /// scan task down within ~one file's processing time.
    pub cancel: CancellationToken,
    /// Mirrors the wire-level scan status. Updated by the scan dispatcher
    /// when the scan terminates (complete or cancelled).
    pub scan_status: ScanStatusBackend,
}

/// Backend representation of [`crate::api::types::ScanStatus`].
///
/// Kept separate from the wire enum so the wire enum can grow `serde`
/// rename rules without affecting backend logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanStatusBackend {
    /// Scan task is still running.
    InProgress,
    /// Scan task finished successfully.
    Complete,
    /// Scan task was cancelled before completing.
    Cancelled,
}

/// Top-level application state.
///
/// `vaults` is wrapped in `Arc<RwLock<...>>` rather than just `RwLock<...>`
/// so background tasks (the scan dispatcher in `events.rs`) can hold a
/// stable handle to the vault map across `await` points. Pure command
/// handlers reach the map via [`AppState::vaults_arc`].
#[derive(Default)]
pub struct AppState {
    vaults: Arc<RwLock<HashMap<String, OpenVault>>>,
    next_vault_seq: AtomicU64,
}

impl AppState {
    /// Create a fresh `AppState`. Called once at app startup.
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrow the vaults map. Most call sites in the command handlers
    /// use this for read/write access during a single command turn.
    pub fn vaults(&self) -> &Arc<RwLock<HashMap<String, OpenVault>>> {
        &self.vaults
    }

    /// Cheap-clone handle for tasks that need to outlive the `&AppState`
    /// borrow — e.g. the scan dispatcher.
    pub fn vaults_arc(&self) -> Arc<RwLock<HashMap<String, OpenVault>>> {
        Arc::clone(&self.vaults)
    }

    /// Mint the next vault id. Session-scoped — process-local and not
    /// persisted. Format is `v<seq>` (e.g. `v1`, `v2`); the frontend
    /// treats it as opaque.
    pub fn new_vault_id(&self) -> String {
        let n = self.next_vault_seq.fetch_add(1, Ordering::Relaxed) + 1;
        format!("v{n}")
    }
}
