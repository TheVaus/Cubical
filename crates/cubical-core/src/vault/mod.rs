//! Vault — the directory-backed root of a Cubical workspace.
//!
//! A vault is any directory the user picks. Cubical creates a `.cubical/`
//! subdirectory inside it holding the libSQL index database and (later)
//! recovery snapshots and user themes. The `.md` files in the vault are the
//! source of truth; everything in `.cubical/` is derived state that can be
//! rebuilt.
//!
//! See `docs/layer-0-spec.md` §3.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cubical_index::{open_index, IndexConn, IndexError};

use crate::file_type::FileTypeRegistry;

mod frontmatter;
mod scan;
mod watcher;

pub use frontmatter::refresh_frontmatter;
pub use scan::{scan, ScanProgress};
pub use watcher::{start_watcher, WatchEvent, WatcherHandle};

/// Errors produced by vault operations.
///
/// Crate-local for now per `docs/layer-0-spec.md` §9 — folded into the
/// consolidated app-level error at the IPC shim boundary.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    /// The supplied path does not exist on disk.
    #[error("vault path does not exist: {0}")]
    NotFound(PathBuf),

    /// The supplied path exists but is not a directory.
    #[error("vault path is not a directory: {0}")]
    NotADirectory(PathBuf),

    /// The supplied path is not writable by this process.
    #[error("vault path is not writable: {0}")]
    NotWritable(PathBuf),

    /// I/O failure while validating or preparing the vault directory.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// The libSQL index could not be opened or migrated.
    #[error("index error: {0}")]
    Index(#[from] IndexError),

    /// The OS file watcher backend failed to start or stopped unexpectedly.
    #[error("watcher error: {0}")]
    Watcher(#[from] notify::Error),

    /// The scan was cancelled before it completed.
    #[error("scan cancelled")]
    ScanCancelled,
}

/// A directory-backed Cubical workspace.
///
/// `Vault` is cheap to clone: every field is shared via [`Arc`] or is a
/// small `PathBuf`. Clones are how the scan task and the command handlers
/// share access without holding a single owner under a mutex.
#[derive(Clone)]
pub struct Vault {
    root: Arc<PathBuf>,
    registry: Arc<FileTypeRegistry>,
    index: Arc<IndexConn>,
}

impl Vault {
    /// Open `path` as a vault.
    ///
    /// Validates that the path exists, is a directory, and is writable;
    /// creates `.cubical/` if missing; opens (or creates) the libSQL index
    /// at `.cubical/index.db` via [`cubical_index::open_index`].
    ///
    /// Returns immediately on success — the directory walk that populates
    /// the `files` table runs separately via [`scan`]. This keeps
    /// `open_vault` under the 100ms target from `docs/layer-0-spec.md` §1
    /// regardless of vault size.
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

        // Probe writability with an atomic temp-file create+remove. `metadata.permissions().readonly()`
        // misses cases like ACL-denied directories on macOS, so this is the
        // authoritative check.
        let probe = cubical_dir.join(".write-probe");
        match std::fs::File::create(&probe) {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
            }
            Err(_) => return Err(VaultError::NotWritable(root)),
        }

        let db_path = cubical_dir.join("index.db");
        let index = open_index(&db_path).await?;

        tracing::info!(path = %root.display(), "vault opened");

        Ok(Self {
            root: Arc::new(root),
            registry: Arc::new(FileTypeRegistry::default()),
            index: Arc::new(index),
        })
    }

    /// The vault root path.
    #[must_use]
    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    /// The file-type registry used to classify files in this vault.
    #[must_use]
    pub fn registry(&self) -> &FileTypeRegistry {
        &self.registry
    }

    /// Cheap-clone access to the registry for tasks that need to outlive
    /// the borrow of [`Self`].
    #[must_use]
    pub fn registry_arc(&self) -> Arc<FileTypeRegistry> {
        Arc::clone(&self.registry)
    }

    /// The open libSQL index handle.
    #[must_use]
    pub fn index(&self) -> &IndexConn {
        &self.index
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
        // Side effect: still exactly one .cubical/ + one index.db.
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
    async fn vault_clone_is_cheap_and_shares_state() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let clone = vault.clone();
        assert_eq!(vault.root(), clone.root());
        // Same handler count via shared registry.
        assert_eq!(vault.registry().len(), clone.registry().len());
    }
}
