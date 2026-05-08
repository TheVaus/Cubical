//! Pure async command handlers for the vault surface.
//!
//! No `tauri` import lives in this module. The Tauri-aware glue (event
//! emission, the `AppHandle` type) is reached through `crate::events`,
//! which is the single migration touchpoint for backend → frontend
//! transport. Handlers are unit-testable by constructing an [`AppState`]
//! and calling them directly; the dispatcher branch is exercised by the
//! `cargo tauri dev` smoke pass and by the events module's logic.
//!
//! See `docs/layer-0-spec.md` §8.

use cubical_core::{start_watcher, Vault, WatchEvent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::api::types::{
    CancelVaultScanRequest, CloseVaultRequest, FileEntry, GetVaultInfoRequest,
    GetVaultInfoResponse, ListFilesRequest, ListFilesResponse, OpenVaultRequest, OpenVaultResponse,
    ScanStatus,
};
use crate::error::CubicalError;
use crate::events::{spawn_scan_dispatcher, spawn_watcher_dispatcher, AppHandle};
use crate::state::{AppState, OpenVault, ScanStatusBackend};

/// Bound on the watcher's mpsc buffer. A burst (e.g. `git checkout`
/// touching dozens of files at once) clears in well under this depth;
/// going much higher would just hide a sluggish dispatcher.
const WATCHER_CHANNEL_DEPTH: usize = 256;

impl From<ScanStatusBackend> for ScanStatus {
    fn from(value: ScanStatusBackend) -> Self {
        match value {
            ScanStatusBackend::InProgress => Self::InProgress,
            ScanStatusBackend::Complete => Self::Complete,
            ScanStatusBackend::Cancelled => Self::Cancelled,
        }
    }
}

/// Open the vault at `req.path` and start its initial scan.
///
/// Returns immediately — the scan runs as a background task whose
/// progress is streamed via `vault:scan-progress` events. Per
/// `docs/layer-0-spec.md` §1, this resolves within 100ms regardless of
/// vault size.
pub async fn open_vault(
    state: &AppState,
    app: &AppHandle,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    let vault = Vault::open(&req.path).await?;
    let vault_id = state.new_vault_id();
    let cancel = CancellationToken::new();

    // Start the watcher *before* registering the vault, so a watcher
    // failure doesn't leave a half-initialized OpenVault in state.
    let (watch_tx, watch_rx) = mpsc::channel::<WatchEvent>(WATCHER_CHANNEL_DEPTH);
    let watcher = start_watcher(&vault, cancel.clone(), watch_tx)?;

    let open = OpenVault {
        vault: vault.clone(),
        cancel: cancel.clone(),
        scan_status: ScanStatusBackend::InProgress,
        watcher: Some(watcher),
    };
    state.vaults().write().await.insert(vault_id.clone(), open);

    spawn_scan_dispatcher(
        app.clone(),
        state.vaults_arc(),
        vault_id.clone(),
        vault.clone(),
        cancel,
    );

    spawn_watcher_dispatcher(app.clone(), vault_id.clone(), vault, watch_rx);

    Ok(OpenVaultResponse {
        vault_id,
        scan_status: ScanStatus::InProgress,
    })
}

/// Cancel an in-flight scan. Idempotent — calling on a finished or
/// already-cancelled vault is a no-op.
pub async fn cancel_vault_scan(
    state: &AppState,
    req: CancelVaultScanRequest,
) -> Result<(), CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    open.cancel.cancel();
    Ok(())
}

/// Return summary metadata for an open vault.
///
/// Safe to call during scan; counts reflect what's been discovered so far.
pub async fn get_vault_info(
    state: &AppState,
    req: GetVaultInfoRequest,
) -> Result<GetVaultInfoResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let conn = open.vault.index().connection();

    let mut rows = conn
        .query("SELECT MAX(version) FROM schema_version", ())
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| CubicalError::Db("schema_version table empty".into()))?;
    let version: Option<i64> = row.get(0)?;
    let schema_version = u32::try_from(version.unwrap_or(0)).unwrap_or(u32::MAX);

    let mut rows = conn
        .query(
            "SELECT
                 COUNT(*),
                 SUM(CASE WHEN type_id = 'markdown' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN type_id = 'binary'   THEN 1 ELSE 0 END)
             FROM files",
            (),
        )
        .await?;
    let (file_count, markdown_count, binary_count) = match rows.next().await? {
        Some(row) => {
            let total: i64 = row.get(0)?;
            let md: Option<i64> = row.get(1)?;
            let bin: Option<i64> = row.get(2)?;
            (
                clamp_to_u32(total),
                clamp_to_u32(md.unwrap_or(0)),
                clamp_to_u32(bin.unwrap_or(0)),
            )
        }
        None => (0, 0, 0),
    };

    Ok(GetVaultInfoResponse {
        path: open.vault.root().to_path_buf(),
        file_count,
        markdown_count,
        binary_count,
        schema_version,
        scan_status: open.scan_status.into(),
    })
}

/// List files tracked in the vault, with optional pagination.
pub async fn list_files(
    state: &AppState,
    req: ListFilesRequest,
) -> Result<ListFilesResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    // Pagination uses i64 since libsql binds integers as i64. u32::MAX
    // converts losslessly.
    let limit: i64 = i64::from(req.limit.unwrap_or(u32::MAX));
    let offset: i64 = i64::from(req.offset.unwrap_or(0));

    let mut rows = conn
        .query(
            "SELECT path, type_id, size_bytes, mtime_unix
             FROM files
             ORDER BY path
             LIMIT ?1 OFFSET ?2",
            libsql::params![limit, offset],
        )
        .await?;
    let mut files: Vec<FileEntry> = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        let type_id: String = row.get(1)?;
        let size_bytes: i64 = row.get(2)?;
        let mtime_unix: i64 = row.get(3)?;
        files.push(FileEntry {
            path,
            type_id,
            size_bytes: u64::try_from(size_bytes).unwrap_or(0),
            mtime_unix,
        });
    }

    let total: i64 = {
        let mut rows = conn.query("SELECT COUNT(*) FROM files", ()).await?;
        match rows.next().await? {
            Some(row) => row.get(0)?,
            None => 0,
        }
    };

    Ok(ListFilesResponse {
        files,
        total: clamp_to_u32(total),
    })
}

/// Cancel any in-flight scan and remove the vault from session state.
///
/// Drops the underlying `IndexConn` (and therefore the libSQL connection)
/// when the last reference goes away — Vault clones inside the scan task
/// keep the connection alive until the scan settles.
pub async fn close_vault(state: &AppState, req: CloseVaultRequest) -> Result<(), CubicalError> {
    let removed = {
        let mut guard = state.vaults().write().await;
        guard.remove(&req.vault_id)
    };
    let Some(open) = removed else {
        return Err(CubicalError::VaultNotOpen(req.vault_id));
    };
    open.cancel.cancel();
    // Drop `open` here; the dispatcher task observes cancellation via
    // its CancellationToken clone and tears itself down. Last reference
    // to the IndexConn is in the scan task — once it exits, the DB is
    // closed.
    drop(open);
    Ok(())
}

fn clamp_to_u32(v: i64) -> u32 {
    if v < 0 {
        0
    } else {
        u32::try_from(v).unwrap_or(u32::MAX)
    }
}
