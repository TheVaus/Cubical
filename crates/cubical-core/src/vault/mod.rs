use std::path::{Path, PathBuf};
use std::sync::Arc;

use cubical_index::{open_index, IndexConn, IndexError};

use crate::file_type::FileTypeRegistry;

mod atomic;
pub mod blocks;
pub mod embeds;
mod frontmatter;
pub mod links;
pub mod mentions;
mod parse;
pub mod pending;
pub mod relpath;
pub mod rename_journal;
mod scan;
pub mod search_refresh;
pub mod settings;
pub mod tags;
mod watcher;

pub use atomic::atomic_write;
pub use blocks::{refresh_block_refs_for_file, refresh_blocks};
pub use frontmatter::{refresh_frontmatter, refresh_frontmatter_with_doc};
pub use links::{
    extract_links, refresh_links, refresh_links_with_doc, resolve_target, LinkExtraction,
};
pub use mentions::{extract_text_runs, find_mention_occurrences, MentionHit, TextRun};
pub use parse::parse_off_executor;
pub use pending::{apply_pending, materialize_on_read};
pub use relpath::{
    contained_join, directory_holds_exact_name, validate_rel_dir, validate_rel_file, RelPathError,
};
pub use scan::{scan, ScanProgress};
pub use tags::{extract_tags, refresh_tags, refresh_tags_with_doc, TagExtraction};
pub use watcher::{start_watcher, WatchEvent, WatcherHandle};

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault path does not exist: {0}")]
    NotFound(PathBuf),

    #[error("vault path is not a directory: {0}")]
    NotADirectory(PathBuf),

    #[error("vault path is not writable: {0}")]
    NotWritable(PathBuf),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("index error: {0}")]
    Index(#[from] IndexError),

    #[error("watcher error: {0}")]
    Watcher(#[from] notify::Error),

    #[error("scan cancelled")]
    ScanCancelled,

    #[error("search index: {0}")]
    Search(String),

    #[error("settings file error: {0}")]
    Settings(String),
}

#[derive(Clone)]
pub struct Vault {
    root: Arc<PathBuf>,
    registry: Arc<FileTypeRegistry>,
    index: Arc<IndexConn>,
    search: Arc<cubical_search::SearchIndex>,
}

impl Vault {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, VaultError> {
        let root = path.as_ref().to_path_buf();

        let metadata = std::fs::metadata(&root).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::NotFound(root.clone()),
            std::io::ErrorKind::PermissionDenied => VaultError::NotWritable(root.clone()),
            _ => VaultError::Io(e),
        })?;
        if !metadata.is_dir() {
            return Err(VaultError::NotADirectory(root));
        }
        if metadata.permissions().readonly() {
            return Err(VaultError::NotWritable(root));
        }

        let cubical_dir = root.join(".cubical");
        std::fs::create_dir_all(&cubical_dir).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => VaultError::NotWritable(root.clone()),
            _ => VaultError::Io(e),
        })?;

        let probe = cubical_dir.join(".write-probe");
        match std::fs::File::create(&probe) {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
            }
            Err(_) => return Err(VaultError::NotWritable(root)),
        }

        let db_path = cubical_dir.join("index.db");
        let index = open_index(&db_path).await?;

        let search_dir = cubical_dir.join("search");
        let search = cubical_search::SearchIndex::open(&search_dir)
            .map_err(|e| VaultError::Search(e.to_string()))?;

        tracing::info!(path = %root.display(), "vault opened");

        Ok(Self {
            root: Arc::new(root),
            registry: Arc::new(FileTypeRegistry::default()),
            index: Arc::new(index),
            search: Arc::new(search),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    #[must_use]
    pub fn registry(&self) -> &FileTypeRegistry {
        &self.registry
    }

    #[must_use]
    pub fn registry_arc(&self) -> Arc<FileTypeRegistry> {
        Arc::clone(&self.registry)
    }

    #[must_use]
    pub fn index(&self) -> &IndexConn {
        &self.index
    }

    #[must_use]
    pub fn search(&self) -> &cubical_search::SearchIndex {
        &self.search
    }
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("root", &self.root)
            .field("handlers", &self.registry.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn open_creates_cubical_dir_and_index_db() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        assert_eq!(vault.root(), dir.path());
        assert!(dir.path().join(".cubical").is_dir());
        assert!(dir.path().join(".cubical/index.db").is_file());
    }

    #[tokio::test]
    async fn open_is_idempotent_on_reopen() {
        let dir = tempdir().unwrap();
        let _ = Vault::open(dir.path()).await.expect("open #1");
        let _ = Vault::open(dir.path()).await.expect("open #2");
        assert!(dir.path().join(".cubical/index.db").is_file());
    }

    #[tokio::test]
    async fn open_errors_when_path_does_not_exist() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("does/not/exist");
        let err = Vault::open(&bogus).await.expect_err("should error");
        match err {
            VaultError::NotFound(p) => assert_eq!(p, bogus),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn open_errors_when_path_is_a_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("not-a-vault.txt");
        std::fs::write(&file_path, b"hi").unwrap();
        let err = Vault::open(&file_path).await.expect_err("should error");
        match err {
            VaultError::NotADirectory(p) => assert_eq!(p, file_path),
            other => panic!("expected NotADirectory, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn vault_open_creates_search_dir_and_stamp() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        let search_dir = tmp.path().join(".cubical").join("search");
        assert!(search_dir.exists());
        assert!(search_dir.join("schema.json").exists());
        assert_eq!(vault.search().doc_count().unwrap(), 0);
    }

    #[tokio::test]
    async fn vault_clone_is_cheap_and_shares_state() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let clone = vault.clone();
        assert_eq!(vault.root(), clone.root());
        assert_eq!(vault.registry().len(), clone.registry().len());
    }
}
