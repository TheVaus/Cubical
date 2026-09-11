use std::sync::atomic::Ordering;
use std::sync::Arc;

use cubical_core::{start_watcher, Vault, WatchEvent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::api::types::{OpenVaultRequest, OpenVaultResponse, ScanStatus};
use crate::commands::vault::find_open_vault_by_canonical_path;
use crate::error::CubicalError;
use crate::events::{
    spawn_scan_dispatcher, spawn_watcher_dispatcher, EventSink, WatchedVault, WatcherLifetime,
};
use crate::state::{AppState, OpenVault, ScanStatusBackend};

const WATCHER_CHANNEL_DEPTH: usize = 256;

pub async fn open_vault(
    state: &AppState,
    app: std::sync::Arc<dyn EventSink>,
    req: OpenVaultRequest,
    advertise_socket: Option<String>,
) -> Result<OpenVaultResponse, CubicalError> {
    let canonical = std::fs::canonicalize(&req.path).ok();
    if let Some(incoming) = &canonical {
        let guard = state.vaults().read().await;
        if let Some((existing_id, status)) = find_open_vault_by_canonical_path(&guard, incoming) {
            return Ok(OpenVaultResponse {
                vault_id: existing_id,
                scan_status: status.into(),
            });
        }
    }

    let lock_key = canonical.unwrap_or_else(|| req.path.clone());
    let lock_guard = match crate::vault_lock::acquire(&lock_key, advertise_socket.as_deref())
        .map_err(|e| CubicalError::Io(format!("acquiring vault lock: {e}")))?
    {
        crate::vault_lock::Acquire::Acquired(guard) => guard,
        crate::vault_lock::Acquire::Held(owner) => {
            return Err(CubicalError::VaultLocked {
                pid: owner.pid,
                socket_path: owner.socket_path,
            });
        }
    };

    let vault = Vault::open(&req.path).await?;
    let search = crate::search_handle::SearchHandle::open(&vault).await;
    let vault_id = state.new_vault_id();
    let cancel = CancellationToken::new();

    let settings = cubical_core::vault::settings::load(vault.root()).unwrap_or_else(|e| {
        tracing::warn!("settings load failed, using defaults: {e}");
        cubical_core::vault::settings::SettingsMap::new()
    });

    let mut open = OpenVault::new(
        vault.clone(),
        search.clone(),
        cancel.clone(),
        ScanStatusBackend::InProgress,
        None,
        settings,
    );
    open.lock_guard = Some(lock_guard);

    let (watch_tx, watch_rx) = mpsc::channel::<WatchEvent>(WATCHER_CHANNEL_DEPTH);
    match start_watcher(&vault, open.watcher_cancel.clone(), watch_tx) {
        Ok(handle) => {
            open.watcher = Some(handle);
            open.watcher_live.store(true, Ordering::Relaxed);
        }
        Err(e) => {
            tracing::warn!(error = %e, "watcher failed to start; vault opens without live updates");
            crate::events::record_vault_warning(
                &vault,
                crate::events::WATCHER_UNAVAILABLE,
                "watcher failed to start; external edits will not be seen until reopen",
                &e.to_string(),
            )
            .await;
        }
    }

    let flush_own_writes = open.flush_own_writes.clone();
    let flush_in_progress = open.flush_in_progress.clone();
    let settings_handle = open.settings.clone();
    let watcher_lifetime = WatcherLifetime {
        cancel: open.watcher_cancel.clone(),
        live: Arc::clone(&open.watcher_live),
    };
    open.flush_timer_live.store(true, Ordering::Relaxed);
    let flush_timer_lifetime = crate::commands::rename::FlushTimerLifetime {
        cancel: open.flush_timer_cancel.clone(),
        live: Arc::clone(&open.flush_timer_live),
    };
    state.vaults().write().await.insert(vault_id.clone(), open);

    spawn_scan_dispatcher(
        app.clone(),
        state.vaults_arc(),
        vault_id.clone(),
        vault.clone(),
        search.scan_sink(),
        crate::search_handle::settle_after_scan,
        cancel,
    );

    spawn_watcher_dispatcher(
        app.clone(),
        vault_id.clone(),
        WatchedVault {
            vault: vault.clone(),
            changes: Arc::new(search),
        },
        watch_rx,
        flush_own_writes.clone(),
        settings_handle.clone(),
        watcher_lifetime,
    );

    crate::commands::rename::spawn_flush_timer(
        app.clone(),
        vault,
        flush_own_writes,
        flush_in_progress,
        settings_handle,
        vault_id.clone(),
        flush_timer_lifetime,
    );

    Ok(OpenVaultResponse {
        vault_id,
        scan_status: ScanStatus::InProgress,
    })
}
