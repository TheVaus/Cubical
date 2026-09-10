use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use cubical_ast::Document;
use cubical_core::{unix_now_secs, ScanSink, Vault};
use cubical_index::{append_audit, AuditLevel};
use cubical_search::{SearchError, SearchIndex};

use crate::commands::open::with_open_vault;
use crate::error::CubicalError;
use crate::events::record_vault_warning;
use crate::state::AppState;

pub const SEARCH_REBUILT: &str = "search_rebuilt";

pub const SEARCH_UNAVAILABLE: &str = "search_unavailable";

const SEARCH_COMMIT_EVERY: usize = 5_000;

#[derive(Clone)]
pub struct SearchHandle {
    index: Option<Arc<SearchIndex>>,
}

impl SearchHandle {
    pub async fn open(vault: &Vault) -> Self {
        let dir = vault.root().join(".cubical").join("search");
        match SearchIndex::open(&dir) {
            Ok(index) => {
                if let Some(reason) = index.rebuilt_reason() {
                    record_rebuild(vault, &dir, reason).await;
                }
                Self {
                    index: Some(Arc::new(index)),
                }
            }
            Err(e) => {
                tracing::error!(
                    dir = %dir.display(),
                    error = %e,
                    "search index failed to open; the vault opens without search",
                );
                record_vault_warning(
                    vault,
                    SEARCH_UNAVAILABLE,
                    "search index failed to open; search is unavailable until the vault is reopened",
                    &e.to_string(),
                )
                .await;
                Self { index: None }
            }
        }
    }

    #[must_use]
    pub fn is_available(&self) -> bool {
        self.index.is_some()
    }

    pub fn index(&self) -> Result<&SearchIndex, CubicalError> {
        self.index.as_deref().ok_or_else(|| {
            CubicalError::Search("search index is unavailable for this vault; reopen it".into())
        })
    }

    pub fn upsert_doc(
        &self,
        path: &str,
        doc: &Document,
        mtime_secs: i64,
        size_bytes: u64,
    ) -> Result<(), SearchError> {
        match &self.index {
            Some(index) => index.upsert(&cubical_search::doc::project_with_doc(
                path, doc, mtime_secs, size_bytes,
            )),
            None => Ok(()),
        }
    }

    pub fn upsert_source(
        &self,
        path: &str,
        source: &str,
        mtime_secs: i64,
        size_bytes: u64,
    ) -> Result<(), SearchError> {
        match &self.index {
            Some(index) => index.upsert(&cubical_search::doc::project(
                path, source, mtime_secs, size_bytes,
            )),
            None => Ok(()),
        }
    }

    pub fn delete(&self, path: &str) -> Result<(), SearchError> {
        match &self.index {
            Some(index) => index.delete_path(path),
            None => Ok(()),
        }
    }

    pub fn commit(&self) -> Result<(), SearchError> {
        match &self.index {
            Some(index) => index.commit(),
            None => Ok(()),
        }
    }

    #[must_use]
    pub fn scan_sink(&self) -> SearchScanSink {
        SearchScanSink {
            search: self.clone(),
            seen: HashSet::new(),
            since_commit: 0,
        }
    }
}

async fn record_rebuild(vault: &Vault, dir: &Path, reason: &str) {
    let detail = serde_json::json!({
        "dir": dir.display().to_string(),
        "reason": reason,
    })
    .to_string();
    if let Err(e) = append_audit(
        vault.index(),
        AuditLevel::Warn,
        SEARCH_REBUILT,
        "search index was unusable; it was wiped and is being rebuilt by the vault scan",
        &detail,
        unix_now_secs(),
    )
    .await
    {
        tracing::warn!(error = %e, "search-rebuild audit insert failed");
    }
}

pub struct SearchScanSink {
    search: SearchHandle,
    seen: HashSet<String>,
    since_commit: usize,
}

impl ScanSink for SearchScanSink {
    fn markdown(&mut self, path: &str, doc: Option<&Document>, mtime_unix: i64, size_bytes: u64) {
        self.seen.insert(path.to_string());
        let Some(doc) = doc else {
            return;
        };
        if let Err(e) = self.search.upsert_doc(path, doc, mtime_unix, size_bytes) {
            tracing::warn!(path, error = %e, "search index refresh failed");
        }
        self.since_commit += 1;
        if self.since_commit >= SEARCH_COMMIT_EVERY {
            if let Err(e) = self.search.commit() {
                tracing::warn!(error = %e, "search index periodic commit failed");
            }
            self.since_commit = 0;
        }
    }

    fn finish(&mut self, walk_complete: bool) {
        if let Err(e) = self.search.commit() {
            tracing::warn!(error = %e, "search index final commit failed");
        }
        if !walk_complete {
            return;
        }
        let Some(index) = &self.search.index else {
            return;
        };
        match index.retain_paths(&self.seen) {
            Ok(removed) if removed > 0 => {
                if let Err(e) = index.commit() {
                    tracing::warn!(error = %e, "search index reconcile commit failed");
                } else {
                    tracing::info!(removed, "search index reconciled (dropped orphan docs)");
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "search index reconcile failed"),
        }
    }
}

pub(crate) async fn open_search_cloned(
    state: &AppState,
    vault_id: &str,
) -> Result<SearchHandle, CubicalError> {
    with_open_vault(state, vault_id, |open| open.search.clone()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_core::ScanProgress;
    use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
    use tempfile::tempdir;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.into(),
            limit: 0,
            offset: 0,
            fields: FieldScope::Default,
            fuzzy: false,
            sort: SortMode::Relevance,
        }
    }

    async fn audit_categories(vault: &Vault) -> Vec<String> {
        let mut rows = vault
            .index()
            .connection()
            .query("SELECT category FROM audit_log ORDER BY id", ())
            .await
            .expect("query");
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.expect("next") {
            out.push(row.get::<String>(0).expect("get"));
        }
        out
    }

    async fn full_scan(vault: &Vault, search: &SearchHandle) {
        let (tx, _rx) = mpsc::channel::<ScanProgress>(256);
        cubical_core::scan(
            vault.clone(),
            CancellationToken::new(),
            tx,
            search.scan_sink(),
        )
        .await
        .expect("scan");
    }

    #[tokio::test]
    async fn open_creates_the_search_dir_and_stamp() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let search = SearchHandle::open(&vault).await;
        let search_dir = dir.path().join(".cubical").join("search");
        assert!(search_dir.join("schema.json").exists());
        assert_eq!(search.index().unwrap().doc_count().unwrap(), 0);
    }

    #[tokio::test]
    async fn upsert_then_commit_finds_the_doc_and_delete_drops_it() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let search = SearchHandle::open(&vault).await;
        let src = "# Hello\n\nworld of search.\n";
        search
            .upsert_source("a.md", src, 0, src.len() as u64)
            .unwrap();
        search.commit().unwrap();
        assert_eq!(search.index().unwrap().doc_count().unwrap(), 1);

        search.delete("a.md").unwrap();
        search.commit().unwrap();
        assert_eq!(search.index().unwrap().doc_count().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_stale_search_dir_is_rebuilt_and_audited() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        drop(SearchHandle::open(&vault).await);
        let before = audit_categories(&vault)
            .await
            .iter()
            .filter(|c| *c == SEARCH_REBUILT)
            .count();

        let stamp = dir
            .path()
            .join(".cubical")
            .join("search")
            .join("schema.json");
        std::fs::write(&stamp, "{\"version\": 0}").unwrap();
        let search = SearchHandle::open(&vault).await;

        assert!(
            search.is_available(),
            "a stale stamp heals, it does not fail"
        );
        let after = audit_categories(&vault)
            .await
            .iter()
            .filter(|c| *c == SEARCH_REBUILT)
            .count();
        assert_eq!(
            after,
            before + 1,
            "the rebuild leaves one search_rebuilt row"
        );
    }

    #[tokio::test]
    async fn an_unopenable_search_dir_degrades_search_not_the_vault() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        std::fs::write(dir.path().join(".cubical").join("search"), b"not a dir").unwrap();

        let search = SearchHandle::open(&vault).await;

        assert!(!search.is_available());
        let err = search.index().err().expect("no index to hand out");
        assert_eq!(serde_json::to_value(&err).unwrap()["code"], "Search");
        search.upsert_source("a.md", "body", 0, 4).unwrap();
        search.delete("a.md").unwrap();
        search.commit().unwrap();
        assert!(audit_categories(&vault)
            .await
            .iter()
            .any(|c| c == SEARCH_UNAVAILABLE));

        std::fs::write(dir.path().join("a.md"), "body\n").unwrap();
        full_scan(&vault, &search).await;
        assert_eq!(
            cubical_index::all_file_paths(vault.index()).await.unwrap(),
            vec!["a.md".to_string()],
            "the vault still scans without its search index",
        );
    }

    #[tokio::test]
    async fn scan_indexes_every_markdown_file_for_search() {
        let n = 60usize;
        let dir = tempdir().unwrap();
        for i in 0..n {
            let p = dir.path().join(format!("note-{i:03}.md"));
            std::fs::write(&p, format!("# Title {i}\n\nzzqx{i:03} body content\n")).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open");
        let search = SearchHandle::open(&vault).await;
        full_scan(&vault, &search).await;

        let index = search.index().unwrap();
        assert_eq!(
            index.doc_count().unwrap(),
            n as u64,
            "every markdown file must land in the search index"
        );
        for i in 0..n {
            let r = run_search(index, &query(&format!("zzqx{i:03}"))).unwrap();
            assert_eq!(
                r.hits.len(),
                1,
                "token zzqx{i:03} should find exactly its file"
            );
            assert_eq!(r.hits[0].path, format!("note-{i:03}.md"));
        }
    }

    #[tokio::test]
    async fn scan_reconciles_orphan_search_docs() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("live.md"), "alpha live note\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let search = SearchHandle::open(&vault).await;

        let ghost = "alpha ghost note";
        search
            .upsert_source("ghost.md", ghost, 0, ghost.len() as u64)
            .unwrap();
        search.commit().unwrap();
        let before = run_search(search.index().unwrap(), &query("alpha"))
            .unwrap()
            .hits;
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].path, "ghost.md", "orphan present pre-scan");

        full_scan(&vault, &search).await;

        let after = run_search(search.index().unwrap(), &query("alpha"))
            .unwrap()
            .hits;
        assert_eq!(after.len(), 1, "ghost doc reconciled away, live indexed");
        assert_eq!(after[0].path, "live.md");
    }

    #[test]
    fn an_unparseable_file_still_counts_as_seen_by_the_reconcile() {
        let dir = tempdir().unwrap();
        let index = SearchIndex::open(dir.path()).unwrap();
        index
            .upsert(&cubical_search::doc::project("broken.md", "kept", 0, 4))
            .unwrap();
        index.commit().unwrap();
        let search = SearchHandle {
            index: Some(Arc::new(index)),
        };

        let mut sink = search.scan_sink();
        sink.markdown("broken.md", None, 0, 4);
        sink.finish(true);

        assert_eq!(
            search.index().unwrap().doc_count().unwrap(),
            1,
            "a failed parse is no evidence the file's search doc is stale",
        );
    }
}
