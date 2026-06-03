//! Wire `cubical-search` into the scan + watcher refresher fan-out.
//!
//! Signature matches the L3 peers (`refresh_links`, `refresh_tags`,
//! `refresh_blocks`): `(vault, rel, source: &str)`. The function parses
//! the source locally via `cubical_ast::parse`, projects an `IndexDoc`,
//! upserts it. Caller commits — either every 5000 docs during scan
//! (see `scan.rs::SEARCH_COMMIT_EVERY`) or on the watcher's debounced
//! cadence (Task 11).

use crate::vault::Vault;
use cubical_search::SearchError;

/// Upsert one file into the Tantivy index. Does not commit.
pub async fn refresh_search_index(
    vault: &Vault,
    rel: &str,
    source: &str,
    mtime_secs: i64,
    size_bytes: u64,
) -> Result<(), SearchError> {
    let doc = cubical_search::doc::project(rel, source, mtime_secs, size_bytes);
    vault.search().upsert(&doc)
}

/// Delete one path from the Tantivy index. Does not commit.
pub async fn delete_search_index(vault: &Vault, rel: &str) -> Result<(), SearchError> {
    vault.search().delete_path(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn refresh_then_query_finds_the_doc() {
        let tmp = TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        let src = "# Hello\n\nworld of search.\n";
        refresh_search_index(&vault, "a.md", src, 0, src.len() as u64)
            .await
            .unwrap();
        vault.search().commit().unwrap();
        assert_eq!(vault.search().doc_count().unwrap(), 1);
    }

    #[tokio::test]
    async fn delete_removes_the_doc() {
        let tmp = TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        refresh_search_index(&vault, "a.md", "x", 0, 1)
            .await
            .unwrap();
        vault.search().commit().unwrap();
        delete_search_index(&vault, "a.md").await.unwrap();
        vault.search().commit().unwrap();
        assert_eq!(vault.search().doc_count().unwrap(), 0);
    }
}
