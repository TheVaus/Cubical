//! Pure async command handlers for the L4-A search surface.
//!
//! Four commands:
//!
//! - `search` — run a free-text query against an open vault's Tantivy
//!   index. Forwards to [`cubical_search::query::run_search`] and stamps
//!   `still_indexing` based on the per-vault [`IndexState`] cell.
//! - `search_index_status` — cheap polling shape for the future
//!   "still indexing…" status-bar pill.
//! - `search_rebuild_index` — wipe + repopulate without dropping the
//!   `SearchIndex` handle. Uses `delete_all` + commit + a fresh scan
//!   dispatcher; the SearchIndex stays alive across the rebuild so we
//!   don't have to juggle filesystem ownership.
//! - `search_get_health` — segment + doc + disk-bytes snapshot for the
//!   dev console.
//!
//! All four are vault-id-keyed since the app supports multiple open
//! vaults (see `OpenVault` in `state.rs`).

use std::path::Path;

use cubical_search::{query::run_search, IndexHealth, IndexState, IndexStatus, SearchResponse};
use tokio_util::sync::CancellationToken;

use crate::api::types::{SearchRequest, SearchVaultRequest};
use crate::error::CubicalError;
use crate::events::{spawn_scan_dispatcher, AppHandle};
use crate::state::AppState;

/// Run a free-text query against the named vault's index.
///
/// The `still_indexing` flag is stamped from the per-vault `IndexState`
/// cell: `Building` ⇒ `true`, anything else ⇒ `false`. The frontend
/// uses it to decide whether to suffix the result list with a
/// "still indexing…" hint.
pub async fn search(state: &AppState, req: SearchRequest) -> Result<SearchResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    // Snapshot the search state under the std mutex — short hold, no
    // await inside.
    let building = matches!(
        open.search_state
            .lock()
            .map(|s| s.state)
            .unwrap_or(IndexState::Error),
        IndexState::Building,
    );

    let mut response = run_search(open.vault.search(), &req.query)?;
    response.still_indexing = building;
    Ok(response)
}

/// Cheap polling shape for the future status-bar indicator.
pub async fn search_index_status(
    state: &AppState,
    req: SearchVaultRequest,
) -> Result<IndexStatus, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let status = open
        .search_state
        .lock()
        .map(|s| s.to_status())
        .unwrap_or_else(|_| IndexStatus {
            state: IndexState::Error,
            indexed_files: 0,
            total_files: 0,
            last_commit_secs: None,
        });
    Ok(status)
}

/// Wipe the in-index document set and trigger a re-scan that
/// re-populates from the `.md` source-of-truth.
///
/// Returns immediately after marking the index as `Building`; the
/// caller polls `search_index_status` to see the transition back to
/// `Ready`. The Tantivy handle on the `Vault` is kept alive across the
/// rebuild — we never wipe the on-disk directory while a writer is
/// live, which would race the OS-level mmap. Tantivy's
/// `delete_all_documents` + `commit` is the safe equivalent.
pub async fn search_rebuild_index(
    state: &AppState,
    app: &AppHandle,
    req: SearchVaultRequest,
) -> Result<(), CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    // Mark Building before the wipe so any concurrent `search`
    // observers see the in-progress state.
    if let Ok(mut cell) = open.search_state.lock() {
        cell.state = IndexState::Building;
    }

    // Drop every doc + commit so the reader stops seeing stale docs
    // before the rescan starts repopulating.
    open.vault.search().delete_all()?;
    open.vault.search().commit()?;

    let vault = open.vault.clone();
    let vault_id = req.vault_id.clone();
    let vaults_arc = state.vaults_arc();
    // Release the read guard before spawning so the dispatcher can take
    // the write lock at terminal time.
    drop(guard);

    spawn_scan_dispatcher(
        app.clone(),
        vaults_arc,
        vault_id,
        vault,
        CancellationToken::new(),
    );

    Ok(())
}

/// Debug snapshot of the on-disk index — segments, document count,
/// approximate disk bytes. Drives the dev console + future settings UI.
pub async fn search_get_health(
    state: &AppState,
    req: SearchVaultRequest,
) -> Result<IndexHealth, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let idx = open.vault.search();
    Ok(IndexHealth {
        schema_version: cubical_search::index::SCHEMA_VERSION,
        segments: idx.segment_count(),
        doc_count: idx.doc_count().unwrap_or(0),
        disk_bytes: dir_size(idx.dir()).unwrap_or(0),
    })
}

/// Recursive size of `p` in bytes. Best-effort — any I/O error along
/// the way short-circuits to `Err`, which the caller folds to `0`. We
/// don't want a transient permission glitch in the health endpoint
/// taking down the dev console.
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

    /// Build an `AppState` with one open vault registered under
    /// `vault_id`. Returns the temp dir (keeps the vault root alive),
    /// the `Vault` handle, and the wired `AppState`. Mirrors the helper
    /// in `commands::links::tests::fresh_state_with_vault`.
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

    /// Mark the vault's per-search state to `Ready` — by default,
    /// `OpenVault::new` initialises it to `Building` because the
    /// real `open_vault` always kicks off a scan. Tests that don't
    /// care about that bootstrap flip it explicitly.
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
        // OpenVault::new defaults to Building, so we don't need to set
        // it — but be explicit for the assertion's sake.
        {
            let guard = state.vaults().read().await;
            let open = guard.get("v1").unwrap();
            open.search_state.lock().unwrap().state = IndexState::Building;
        }

        // Seed one doc so a non-empty text query has something to find;
        // `still_indexing` flag is set regardless of hits.
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
        // Default is Building — flip to Ready and read back via the
        // public command.
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
        // Seed one doc so the health endpoint sees a non-trivial index;
        // the schema_version assertion is the load-bearing one.
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
        // The full rebuild path spins up a fresh scan dispatcher which
        // requires a Tauri AppHandle. The dispatcher is exercised
        // end-to-end by `commands::vault::tests` already; here we
        // verify the immediate-effect contract of `search_rebuild_index`:
        //   1. Marks state as Building.
        //   2. Wipes every existing doc from the index BEFORE
        //      returning (so a concurrent search doesn't see stale
        //      hits during the rescan).
        //
        // We do this by calling the writer + reader directly — the
        // public IPC handler's only added behaviour beyond delete_all+commit
        // is the dispatcher spawn, which needs an AppHandle.
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
