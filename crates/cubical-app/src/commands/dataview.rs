//! Pure async handler for the `dataview_query` command.
//!
//! Parses + runs a ```query block against the named vault's index.
//! Parse and execution failures are folded into `DataviewResult::Error`
//! (the command still returns `Ok`) so the editor widget always renders
//! a structured answer rather than a thrown IPC error. Only
//! vault-not-open is a hard error.

use crate::api::types::{DataviewQueryRequest, DataviewResult};
use crate::error::CubicalError;
use crate::state::AppState;

/// Evaluate a Dataview query against the named vault.
pub async fn dataview_query(
    state: &AppState,
    req: DataviewQueryRequest,
) -> Result<DataviewResult, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let query = match cubical_query::parse(&req.source) {
        Ok(q) => q,
        Err(e) => {
            return Ok(DataviewResult::Error {
                message: e.to_string(),
            })
        }
    };
    match cubical_query::run(open.vault.index(), &query).await {
        Ok(result) => Ok(result.into()),
        Err(e) => Ok(DataviewResult::Error {
            message: e.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault.clone(),
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
            ),
        );
        (dir, vault, state)
    }

    async fn seed(vault: &Vault, path: &str, status_json: &str) {
        let c = vault.index().connection();
        c.execute(
            "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
             inode, last_seen, created_at, updated_at) VALUES (?1,'markdown',0,0,'',NULL,0,0,0)",
            libsql::params![path],
        )
        .await
        .unwrap();
        c.execute(
            "INSERT INTO frontmatter (file_path, key, value) VALUES (?1,'status',?2)",
            libsql::params![path, status_json],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn count_matches() {
        let (_d, vault, state) = fresh_state_with_vault("v1").await;
        seed(&vault, "a.md", "\"in-progress\"").await;
        seed(&vault, "b.md", "\"done\"").await;
        let req = DataviewQueryRequest {
            vault_id: "v1".into(),
            source: r#"COUNT WHERE status = "in-progress""#.into(),
        };
        match dataview_query(&state, req).await.unwrap() {
            DataviewResult::Count { count } => assert_eq!(count, 1),
            other => panic!("expected count, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn bad_query_returns_error_variant_not_err() {
        let (_d, _vault, state) = fresh_state_with_vault("v1").await;
        let req = DataviewQueryRequest {
            vault_id: "v1".into(),
            source: "FETCH stuff".into(),
        };
        match dataview_query(&state, req).await.unwrap() {
            DataviewResult::Error { message } => assert!(!message.is_empty()),
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_d, _vault, state) = fresh_state_with_vault("v1").await;
        let req = DataviewQueryRequest {
            vault_id: "ghost".into(),
            source: "LIST".into(),
        };
        let err = dataview_query(&state, req)
            .await
            .expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
