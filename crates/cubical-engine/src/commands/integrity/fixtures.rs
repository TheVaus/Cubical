use cubical_core::Vault;
use libsql::params;
use tempfile::{tempdir, TempDir};
use tokio_util::sync::CancellationToken;

use crate::state::{AppState, OpenVault, ScanStatusBackend};

pub(super) async fn vault_with(files: &[(&str, &str)]) -> (TempDir, Vault, AppState) {
    let dir = tempdir().unwrap();
    for (rel, body) in files {
        let abs = dir.path().join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&abs, body).unwrap();
    }
    let vault = Vault::open(dir.path()).await.expect("open");
    scan(&vault).await;
    let state = AppState::new();
    state.vaults().write().await.insert(
        "v1".to_string(),
        OpenVault::new(
            vault.clone(),
            CancellationToken::new(),
            ScanStatusBackend::Complete,
            None,
            cubical_core::vault::settings::SettingsMap::new(),
        ),
    );
    (dir, vault, state)
}

pub(super) async fn scan(vault: &Vault) {
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
        .await
        .unwrap();
}

pub(super) async fn drop_file_as_watcher_would(dir: &TempDir, vault: &Vault, rel: &str) {
    std::fs::remove_file(dir.path().join(rel)).unwrap();
    vault
        .index()
        .connection()
        .execute("DELETE FROM files WHERE path = ?1", params![rel])
        .await
        .unwrap();
}
