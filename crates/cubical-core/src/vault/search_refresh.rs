use crate::vault::Vault;
use cubical_ast::Document;
use cubical_search::SearchError;

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

pub async fn refresh_search_index_with_doc(
    vault: &Vault,
    rel: &str,
    doc: &Document,
    mtime_secs: i64,
    size_bytes: u64,
) -> Result<(), SearchError> {
    let indexed = cubical_search::doc::project_with_doc(rel, doc, mtime_secs, size_bytes);
    vault.search().upsert(&indexed)
}

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
