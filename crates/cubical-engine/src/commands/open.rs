use std::sync::Arc;

use cubical_core::Vault;

use crate::error::CubicalError;
use crate::plugins::{ensure_active, Feature};
use crate::state::{AppState, OpenVault};

pub(crate) async fn with_open_vault<T, F>(
    state: &AppState,
    vault_id: &str,
    take: F,
) -> Result<T, CubicalError>
where
    F: FnOnce(&OpenVault) -> T,
{
    let guard = state.vaults().read().await;
    let open = guard
        .get(vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(vault_id.to_string()))?;
    Ok(take(open))
}

pub(crate) async fn open_vault_cloned(
    state: &AppState,
    vault_id: &str,
) -> Result<Vault, CubicalError> {
    with_open_vault(state, vault_id, |open| open.vault.clone()).await
}

pub(crate) async fn open_vault_cloned_for(
    state: &AppState,
    vault_id: &str,
    feature: Feature,
) -> Result<Vault, CubicalError> {
    let (vault, settings) = with_open_vault(state, vault_id, |open| {
        (open.vault.clone(), Arc::clone(&open.settings))
    })
    .await?;
    ensure_active(&settings, feature).await?;
    Ok(vault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ScanStatusBackend;
    use tokio_util::sync::CancellationToken;

    async fn state_with_vault(vault_id: &str) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, state)
    }

    #[tokio::test]
    async fn an_unknown_vault_id_is_vault_not_open() {
        let (_dir, state) = state_with_vault("v1").await;
        let err = open_vault_cloned(&state, "ghost")
            .await
            .expect_err("unknown vault");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }

    #[tokio::test]
    async fn the_read_guard_is_released_before_the_caller_resumes() {
        let (_dir, state) = state_with_vault("v1").await;
        let vault = open_vault_cloned(&state, "v1").await.expect("cloned");
        state.vaults().write().await.insert(
            "v2".into(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        assert_eq!(state.vaults().read().await.len(), 2);
    }
}
