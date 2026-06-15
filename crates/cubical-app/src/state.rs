//! Application state container.
//!
//! `AppState` is plain Rust — no Tauri imports. Tauri stores it via
//! `app.manage(state)`; pure command handlers in `crate::commands` take
//! `&AppState`. The Tauri shim in `lib.rs` is the only place that knows
//! how state is wrapped (`tauri::State<'_, AppState>`).
//!
//! See `docs/migration-touchpoints.md` for the rationale.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use cubical_core::{vault::settings::SettingsMap, Vault, WatcherHandle};
use cubical_search::{IndexState, IndexStatus};

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
    /// Active filesystem watcher. Held here so it lives as long as the
    /// vault is open; dropping it (via `close_vault`) tears down the OS
    /// watch and aborts the watcher dispatcher's bridge task.
    pub watcher: Option<WatcherHandle>,
    /// L3 Session J — backend own-write hash gate. The flush executor
    /// inserts `(relative_path, content_hash_hex)` before writing; the
    /// watcher dispatcher's `Modified` branch consumes (removes) the
    /// entry to suppress its `vault:file-changed` emit, preventing flush
    /// rewrites from bouncing back into the editor as external edits.
    pub flush_own_writes: Arc<Mutex<HashSet<(PathBuf, String)>>>,
    /// L3 Session J — per-vault flush guard. Held for the duration of
    /// any flush (timer / manual / close / >50 fuse) so concurrent
    /// triggers don't interleave; second caller blocks behind the first.
    pub flush_in_progress: Arc<Mutex<()>>,
    /// L3 Session J — cancellation handle for the per-vault periodic
    /// flush timer task spawned in `open_vault`. Fired from `close_vault`
    /// before the synchronous close-time flush so the timer task exits
    /// cleanly rather than racing the index handle drop.
    pub flush_timer_cancel: CancellationToken,
    /// L4-A — per-vault Tantivy index state. Set to `Building` while the
    /// initial scan (or a rebuild) is in flight; the scan dispatcher
    /// transitions it to `Ready` on success. `Arc<Mutex<...>>` so the
    /// dispatcher task and the IPC handlers can share a stable handle
    /// across `await` points without cloning the whole `OpenVault`.
    pub search_state: Arc<std::sync::Mutex<SearchStateInner>>,
    /// In-memory copy of the durable settings (`.cubical/config.toml`),
    /// the source of truth for non-`ui.*` keys. Workspace `ui.*` state
    /// stays in the DB `config` table.
    pub settings: Arc<RwLock<SettingsMap>>,
}

/// L4-A — per-vault Tantivy index state, shared across handlers and the
/// scan dispatcher. Mirrors the wire shape of `IndexStatus` so polling
/// is a single guard read.
#[derive(Debug, Clone)]
pub struct SearchStateInner {
    /// Current high-level state.
    pub state: IndexState,
    /// Files indexed so far this session (best-effort; updated by the
    /// scan + watcher refresh hooks once those plumb in — Task 12 lands
    /// only the state cell + state transitions).
    pub indexed_files: u64,
    /// Total file count the most recent scan enumerated.
    pub total_files: u64,
    /// Unix seconds of the most recent commit, if any.
    pub last_commit_secs: Option<i64>,
}

impl Default for SearchStateInner {
    fn default() -> Self {
        // Vault open always kicks off an initial scan, so the wire-correct
        // starting state is `Building`. The scan dispatcher flips this to
        // `Ready` (or `Error`) when the scan terminates.
        Self {
            state: IndexState::Building,
            indexed_files: 0,
            total_files: 0,
            last_commit_secs: None,
        }
    }
}

impl SearchStateInner {
    /// Snapshot as a wire-shaped `IndexStatus`.
    pub fn to_status(&self) -> IndexStatus {
        IndexStatus {
            state: self.state,
            indexed_files: self.indexed_files,
            total_files: self.total_files,
            last_commit_secs: self.last_commit_secs,
        }
    }
}

impl OpenVault {
    /// Construct an `OpenVault` with default-empty flush state.
    ///
    /// Single constructor used by both `open_vault` and test fixtures —
    /// keeps the three new L3 Session J fields out of every call site's
    /// struct-literal shape.
    pub fn new(
        vault: Vault,
        cancel: CancellationToken,
        scan_status: ScanStatusBackend,
        watcher: Option<WatcherHandle>,
        settings: SettingsMap,
    ) -> Self {
        Self {
            vault,
            cancel,
            scan_status,
            watcher,
            flush_own_writes: Arc::new(Mutex::new(HashSet::new())),
            flush_in_progress: Arc::new(Mutex::new(())),
            flush_timer_cancel: CancellationToken::new(),
            search_state: Arc::new(std::sync::Mutex::new(SearchStateInner::default())),
            settings: Arc::new(RwLock::new(settings)),
        }
    }
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
