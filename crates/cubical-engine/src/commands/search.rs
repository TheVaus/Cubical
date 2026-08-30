use std::path::Path;
use std::sync::Arc;

use cubical_search::{query::run_search, IndexHealth, IndexState, IndexStatus, SearchResponse};
use tokio_util::sync::CancellationToken;

use crate::api::types::{SearchRequest, SearchVaultRequest};
use crate::commands::open::{open_vault_cloned, with_open_vault};
use crate::error::CubicalError;
use crate::events::{spawn_scan_dispatcher, EventSink};
use crate::state::AppState;

pub async fn search(state: &AppState, req: SearchRequest) -> Result<SearchResponse, CubicalError> {
    let (vault, search_state) = with_open_vault(state, &req.vault_id, |open| {
        (open.vault.clone(), Arc::clone(&open.search_state))
    })
    .await?;

    let building = matches!(
        search_state
            .lock()
            .map(|s| s.state)
            .unwrap_or(IndexState::Error),
        IndexState::Building,
    );

    let mut response = run_search(vault.search(), &req.query)?;
    response.still_indexing = building;
    Ok(response)
}

pub async fn search_index_status(
    state: &AppState,
    req: SearchVaultRequest,
) -> Result<IndexStatus, CubicalError> {
    let status = with_open_vault(state, &req.vault_id, |open| {
        open.search_state
            .lock()
            .map(|s| s.to_status())
            .unwrap_or_else(|_| IndexStatus {
                state: IndexState::Error,
                indexed_files: 0,
                total_files: 0,
                last_commit_secs: None,
            })
    })
    .await?;
    Ok(status)
}

pub async fn search_rebuild_index(
    state: &AppState,
    app: std::sync::Arc<dyn EventSink>,
    req: SearchVaultRequest,
) -> Result<(), CubicalError> {
    let (vault, search_state) = with_open_vault(state, &req.vault_id, |open| {
        (open.vault.clone(), Arc::clone(&open.search_state))
    })
    .await?;

    if let Ok(mut cell) = search_state.lock() {
        cell.state = IndexState::Building;
    }

    vault.search().delete_all()?;
    vault.search().commit()?;

    spawn_scan_dispatcher(
        app.clone(),
        state.vaults_arc(),
        req.vault_id.clone(),
        vault,
        CancellationToken::new(),
    );

    Ok(())
}

pub async fn search_get_health(
    state: &AppState,
    req: SearchVaultRequest,
) -> Result<IndexHealth, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;

    let idx = vault.search();
    Ok(IndexHealth {
        schema_version: cubical_search::index::SCHEMA_VERSION,
        segments: idx.segment_count(),
        doc_count: idx.doc_count().unwrap_or(0),
        disk_bytes: dir_size(idx.dir()).unwrap_or(0),
    })
}

fn dir_size(p: &Path) -> std::io::Result<u64> {
    let mut total = 0;
    for entry in std::fs::read_dir(p)? {
        let entry = entry?;
        let md = entry.metadata()?;
        total += if md.is_file() {
            md.len()
        } else {
            dir_size(&entry.path())?
        };
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::types::SearchQuery;
    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_search::IndexState;
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
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, vault, state)
    }

    async fn mark_ready(state: &AppState, vault_id: &str) {
        let guard = state.vaults().read().await;
        let open = guard.get(vault_id).unwrap();
        open.search_state.lock().unwrap().state = IndexState::Ready;
    }

    #[tokio::test]
    async fn search_round_trips_empty_query() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        mark_ready(&state, "v1").await;

        let resp = search(
            &state,
            SearchRequest {
                vault_id: "v1".into(),
                query: SearchQuery {
                    text: "".into(),
                    limit: 0,
                    offset: 0,
                    fields: Default::default(),
                    fuzzy: false,
                    sort: Default::default(),
                },
            },
        )
        .await
        .expect("ok");

        assert!(resp.hits.is_empty(), "empty query yields no hits");
        assert!(!resp.still_indexing, "Ready state ⇒ still_indexing=false");
    }

    #[tokio::test]
    async fn still_indexing_flag_set_when_state_is_building() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        {
            let guard = state.vaults().read().await;
            let open = guard.get("v1").unwrap();
            open.search_state.lock().unwrap().state = IndexState::Building;
        }

        let src = "# Hello\n\nworld of search.\n";
        cubical_core::vault::search_refresh::refresh_search_index(
            &vault,
            "a.md",
            src,
            0,
            src.len() as u64,
        )
        .await
        .unwrap();
        vault.search().commit().unwrap();

        let resp = search(
            &state,
            SearchRequest {
                vault_id: "v1".into(),
                query: SearchQuery {
                    text: "hello".into(),
                    limit: 0,
                    offset: 0,
                    fields: Default::default(),
                    fuzzy: false,
                    sort: Default::default(),
                },
            },
        )
        .await
        .expect("ok");

        assert!(
            resp.still_indexing,
            "Building state must stamp still_indexing=true",
        );
    }

    #[tokio::test]
    async fn status_reflects_state_cell() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        mark_ready(&state, "v1").await;

        let st = search_index_status(
            &state,
            SearchVaultRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(st.state, IndexState::Ready));
    }

    #[tokio::test]
    async fn health_reports_schema_version_2() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        let src = "# Hello\n\nbody.\n";
        cubical_core::vault::search_refresh::refresh_search_index(
            &vault,
            "a.md",
            src,
            0,
            src.len() as u64,
        )
        .await
        .unwrap();
        vault.search().commit().unwrap();

        let h = search_get_health(
            &state,
            SearchVaultRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(
            h.schema_version,
            cubical_search::index::SCHEMA_VERSION,
            "health must report the current schema version",
        );
        assert_eq!(h.schema_version, 2, "L4-B bumps SCHEMA_VERSION to 2");
        assert_eq!(h.doc_count, 1, "the seeded doc must be visible");
        assert!(h.disk_bytes > 0, "non-empty index has on-disk bytes");
    }

    #[tokio::test]
    async fn search_unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = search(
            &state,
            SearchRequest {
                vault_id: "ghost".into(),
                query: SearchQuery {
                    text: "x".into(),
                    limit: 0,
                    offset: 0,
                    fields: Default::default(),
                    fuzzy: false,
                    sort: Default::default(),
                },
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }

    #[tokio::test]
    async fn rebuild_wipes_docs_immediately() {
        let (_dir, vault, _state) = fresh_state_with_vault("v1").await;
        let src = "# Hello\n\nbody one.\n";
        cubical_core::vault::search_refresh::refresh_search_index(
            &vault,
            "a.md",
            src,
            0,
            src.len() as u64,
        )
        .await
        .unwrap();
        cubical_core::vault::search_refresh::refresh_search_index(
            &vault,
            "b.md",
            src,
            0,
            src.len() as u64,
        )
        .await
        .unwrap();
        vault.search().commit().unwrap();
        assert_eq!(vault.search().doc_count().unwrap(), 2);

        vault.search().delete_all().unwrap();
        vault.search().commit().unwrap();
        assert_eq!(
            vault.search().doc_count().unwrap(),
            0,
            "delete_all + commit must clear the reader's view",
        );
    }
}
