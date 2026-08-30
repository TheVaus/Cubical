use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use cubical_core::{vault::settings::SettingsMap, Vault, WatcherHandle};
use cubical_search::{IndexState, IndexStatus};

pub struct OpenVault {
    pub vault: Vault,
    pub cancel: CancellationToken,
    pub scan_status: ScanStatusBackend,
    pub watcher: Option<WatcherHandle>,
    pub watcher_cancel: CancellationToken,
    pub watcher_live: Arc<AtomicBool>,
    pub flush_own_writes: Arc<Mutex<HashSet<(String, String)>>>,
    pub flush_in_progress: Arc<Mutex<()>>,
    pub flush_timer_cancel: CancellationToken,
    pub search_state: Arc<std::sync::Mutex<SearchStateInner>>,
    pub settings: Arc<RwLock<SettingsMap>>,
    pub lock_guard: Option<crate::vault_lock::VaultLockGuard>,
}

#[derive(Debug, Clone)]
pub struct SearchStateInner {
    pub state: IndexState,
    pub indexed_files: u64,
    pub total_files: u64,
    pub last_commit_secs: Option<i64>,
}

impl Default for SearchStateInner {
    fn default() -> Self {
        Self {
            state: IndexState::Building,
            indexed_files: 0,
            total_files: 0,
            last_commit_secs: None,
        }
    }
}

impl SearchStateInner {
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
            watcher_cancel: CancellationToken::new(),
            watcher_live: Arc::new(AtomicBool::new(watcher.is_some())),
            watcher,
            flush_own_writes: Arc::new(Mutex::new(HashSet::new())),
            flush_in_progress: Arc::new(Mutex::new(())),
            flush_timer_cancel: CancellationToken::new(),
            search_state: Arc::new(std::sync::Mutex::new(SearchStateInner::default())),
            settings: Arc::new(RwLock::new(settings)),
            lock_guard: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanStatusBackend {
    InProgress,
    Complete,
    Cancelled,
}

#[derive(Default)]
pub struct AppState {
    vaults: Arc<RwLock<HashMap<String, OpenVault>>>,
    next_vault_seq: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn vaults(&self) -> &Arc<RwLock<HashMap<String, OpenVault>>> {
        &self.vaults
    }

    pub fn vaults_arc(&self) -> Arc<RwLock<HashMap<String, OpenVault>>> {
        Arc::clone(&self.vaults)
    }

    pub fn new_vault_id(&self) -> String {
        let n = self.next_vault_seq.fetch_add(1, Ordering::Relaxed) + 1;
        format!("v{n}")
    }
}
