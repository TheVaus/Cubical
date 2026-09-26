use std::path::Path;
use std::sync::{Arc, PoisonError};

use cubical_search::{query::run_search, IndexHealth, IndexState, IndexStatus};
use serde::Deserialize;

pub use cubical_search::{
    FieldScope as SearchFieldScope, IndexHealth as SearchHealthDto, IndexState as SearchIndexState,
    IndexStatus as SearchIndexStatusDto, MatchedField as SearchMatchedField, SearchHit,
    SearchQuery, SearchResponse, SortMode as SearchSortMode,
};

#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub vault_id: String,
    pub query: SearchQuery,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchVaultRequest {
    pub vault_id: String,
}

use crate::commands::open::with_open_vault;
use crate::error::CubicalError;
use crate::events::{spawn_scan_dispatcher, EventSink};
use crate::search_handle::open_search_cloned;
use crate::state::AppState;
use tokio_util::sync::CancellationToken;

pub async fn search(state: &AppState, req: SearchRequest) -> Result<SearchResponse, CubicalError> {
    crate::plugins::require(state, &req.vault_id, crate::plugins::Feature::Search).await?;

    let (search, search_state) = with_open_vault(state, &req.vault_id, |open| {
        (open.search.clone(), Arc::clone(&open.search_state))
    })
    .await?;

    let building = matches!(
        search_state
            .lock()
            .map(|s| s.state)
            .unwrap_or(IndexState::Error),
        IndexState::Building,
    );

    let mut response = tokio::task::spawn_blocking(move || -> Result<_, CubicalError> {
        Ok(run_search(search.index()?, &req.query)?)
    })
    .await
    .map_err(|e| CubicalError::Io(format!("search task join error: {e}")))??;
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
    let (vault, search, cancel, search_state) = {
        let mut guard = state.vaults().write().await;
        let open = guard
            .get_mut(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        if open.cancel.is_cancelled() {
            open.cancel = CancellationToken::new();
        }
        (
            open.vault.clone(),
            open.search.clone(),
            open.cancel.clone(),
            Arc::clone(&open.search_state),
        )
    };

    let index = search.index()?;
    search_state
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .state = IndexState::Building;

    index.delete_all()?;
    index.commit()?;

    spawn_scan_dispatcher(
        app.clone(),
        state.vaults_arc(),
        req.vault_id.clone(),
        vault,
        search.scan_sink(),
        crate::search_handle::settle_after_scan,
        cancel,
    );

    Ok(())
}

pub async fn search_get_health(
    state: &AppState,
    req: SearchVaultRequest,
) -> Result<IndexHealth, CubicalError> {
    let search = open_search_cloned(state, &req.vault_id).await?;

    let idx = search.index()?;
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
    use super::SearchQuery;
    use super::*;
    use crate::search_handle::SearchHandle;
    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_search::IndexState;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, SearchHandle, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let handle = SearchHandle::open(&vault).await;
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault,
                handle.clone(),
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, handle, state)
    }

    async fn switch(state: &AppState, vault_id: &str, key: &str, on: bool) {
        let settings = crate::commands::open::with_open_vault(state, vault_id, |open| {
            std::sync::Arc::clone(&open.settings)
        })
        .await
        .expect("vault open");
        settings
            .write()
            .await
            .insert(key.to_string(), serde_json::json!(on));
    }

    async fn mark_ready(state: &AppState, vault_id: &str) {
        let guard = state.vaults().read().await;
        let open = guard.get(vault_id).unwrap();
        open.search_state.lock().unwrap().state = IndexState::Ready;
    }

    #[tokio::test]
    async fn search_round_trips_empty_query() {
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
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
        let (_dir, handle, state) = fresh_state_with_vault("v1").await;
        {
            let guard = state.vaults().read().await;
            let open = guard.get("v1").unwrap();
            open.search_state.lock().unwrap().state = IndexState::Building;
        }

        let src = "# Hello\n\nworld of search.\n";
        handle
            .upsert_source("a.md", src, 0, src.len() as u64)
            .unwrap();
        handle.index().unwrap().commit().unwrap();

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
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
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
        let (_dir, handle, state) = fresh_state_with_vault("v1").await;
        let src = "# Hello\n\nbody.\n";
        handle
            .upsert_source("a.md", src, 0, src.len() as u64)
            .unwrap();
        handle.index().unwrap().commit().unwrap();

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
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
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

    async fn scan_status(state: &AppState, vault_id: &str) -> ScanStatusBackend {
        state
            .vaults()
            .read()
            .await
            .get(vault_id)
            .unwrap()
            .scan_status
    }

    async fn stored_cancel(state: &AppState, vault_id: &str) -> CancellationToken {
        state
            .vaults()
            .read()
            .await
            .get(vault_id)
            .unwrap()
            .cancel
            .clone()
    }

    async fn wait_for_scan_status(state: &AppState, vault_id: &str, want: ScanStatusBackend) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while scan_status(state, vault_id).await != want {
            assert!(
                std::time::Instant::now() < deadline,
                "scan never reached {want:?}",
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_rebuild_runs_under_the_vaults_own_cancellation_token() {
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
        state
            .vaults()
            .write()
            .await
            .get_mut("v1")
            .unwrap()
            .scan_status = ScanStatusBackend::InProgress;

        search_rebuild_index(
            &state,
            std::sync::Arc::new(crate::events::NoopEventSink),
            SearchVaultRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("rebuild dispatches");

        let stored = stored_cancel(&state, "v1").await;
        assert!(
            !stored.is_cancelled(),
            "the rebuild's token is the one close_vault will cancel",
        );
        wait_for_scan_status(&state, "v1", ScanStatusBackend::Complete).await;
    }

    #[tokio::test]
    async fn a_rebuild_after_a_cancelled_scan_still_rebuilds() {
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
        let first = stored_cancel(&state, "v1").await;
        first.cancel();
        state
            .vaults()
            .write()
            .await
            .get_mut("v1")
            .unwrap()
            .scan_status = ScanStatusBackend::Cancelled;

        search_rebuild_index(
            &state,
            std::sync::Arc::new(crate::events::NoopEventSink),
            SearchVaultRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("rebuild dispatches");

        let replaced = stored_cancel(&state, "v1").await;
        assert!(
            !replaced.is_cancelled(),
            "a cancelled scan token must not doom every later rebuild",
        );
        wait_for_scan_status(&state, "v1", ScanStatusBackend::Complete).await;
        let status = search_index_status(
            &state,
            SearchVaultRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("status");
        assert!(matches!(status.state, IndexState::Ready));
    }

    #[tokio::test]
    async fn rebuild_wipes_docs_immediately() {
        let (_dir, handle, _state) = fresh_state_with_vault("v1").await;
        let src = "# Hello\n\nbody one.\n";
        handle
            .upsert_source("a.md", src, 0, src.len() as u64)
            .unwrap();
        handle
            .upsert_source("b.md", src, 0, src.len() as u64)
            .unwrap();
        handle.index().unwrap().commit().unwrap();
        assert_eq!(handle.index().unwrap().doc_count().unwrap(), 2);

        handle.index().unwrap().delete_all().unwrap();
        handle.index().unwrap().commit().unwrap();
        assert_eq!(
            handle.index().unwrap().doc_count().unwrap(),
            0,
            "delete_all + commit must clear the reader's view",
        );
    }

    #[tokio::test]
    async fn a_query_is_refused_while_the_search_plugin_is_off() {
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
        mark_ready(&state, "v1").await;
        switch(&state, "v1", "plugins.search_enabled", false).await;

        let err = search(
            &state,
            SearchRequest {
                vault_id: "v1".into(),
                query: SearchQuery {
                    text: "anything".into(),
                    limit: 10,
                    offset: 0,
                    fields: Default::default(),
                    fuzzy: false,
                    sort: Default::default(),
                },
            },
        )
        .await
        .expect_err("a switched-off plugin must not be served");

        assert!(matches!(err, CubicalError::FeatureDisabled(id) if id == "search"));
    }

    #[tokio::test]
    async fn the_index_keeps_reporting_while_the_search_plugin_is_off() {
        let (_dir, _handle, state) = fresh_state_with_vault("v1").await;
        mark_ready(&state, "v1").await;
        switch(&state, "v1", "plugins.search_enabled", false).await;

        let status = search_index_status(
            &state,
            SearchVaultRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("the toggle gates the query, never the index behind it");

        assert!(matches!(status.state, IndexState::Ready));
    }
}
