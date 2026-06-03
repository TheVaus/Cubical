//! Consolidated app-level error type.
//!
//! Per `docs/layer-0-spec.md` §9, the IPC boundary speaks one error type.
//! `CubicalError` folds the crate-local error types — `VaultError` from
//! `cubical-core`, `IndexError` from `cubical-index`, `FileTypeError` from
//! `cubical-core` — into a single enum that serializes to a stable JSON
//! shape for the frontend.
//!
//! The spec originally placed this in `cubical-core`, but the actual
//! workspace dep graph (cubical-core consumes cubical-index for the
//! libSQL handle) means the consolidated error must live downstream of
//! both crates. `cubical-app` is the natural home — it's the only crate
//! that needs to fold every error variant — and there is no IPC layer
//! below this one that would need the same fold.

use serde::{Serialize, Serializer};

use cubical_core::{FileTypeError, VaultError};
use cubical_index::IndexError;

/// Every fallible IPC command returns `Result<T, CubicalError>`.
///
/// Variants are stable wire identifiers. Renaming a variant is a
/// frontend-breaking change.
#[derive(Debug, thiserror::Error)]
pub enum CubicalError {
    /// The vault path does not exist on disk.
    #[error("vault not found: {0}")]
    VaultNotFound(String),

    /// The vault path exists but is not a directory.
    #[error("vault path is not a directory: {0}")]
    VaultNotADirectory(String),

    /// The vault path is not writable by this process.
    #[error("vault path is not writable: {0}")]
    VaultNotWritable(String),

    /// The on-disk schema is newer than this build supports.
    #[error("schema version {0} is newer than this build supports")]
    SchemaVersionUnsupported(u32),

    /// The named vault is not currently open in this session.
    #[error("vault not open: {0}")]
    VaultNotOpen(String),

    /// The named file is not tracked in the vault's index.
    #[error("file not found in vault: {0}")]
    FileNotFound(String),

    /// The scan was cancelled before completing.
    #[error("scan cancelled")]
    ScanCancelled,

    /// I/O failure.
    #[error("io error: {0}")]
    Io(String),

    /// libSQL failure.
    #[error("database error: {0}")]
    Db(String),

    /// File-type handler failure (hash, sanitize).
    #[error("file type error: {0}")]
    FileType(String),

    /// OS file watcher failure.
    #[error("watcher error: {0}")]
    Watcher(String),

    /// Tantivy search index failure.
    #[error("search index error: {0}")]
    Search(String),

    /// Argument validation failure.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

impl CubicalError {
    /// Stable `code` field for the JSON wire shape. Used by `Serialize`
    /// and available for tests / logs.
    fn code(&self) -> &'static str {
        match self {
            Self::VaultNotFound(_) => "VaultNotFound",
            Self::VaultNotADirectory(_) => "VaultNotADirectory",
            Self::VaultNotWritable(_) => "VaultNotWritable",
            Self::SchemaVersionUnsupported(_) => "SchemaVersionUnsupported",
            Self::VaultNotOpen(_) => "VaultNotOpen",
            Self::FileNotFound(_) => "FileNotFound",
            Self::ScanCancelled => "ScanCancelled",
            Self::Io(_) => "Io",
            Self::Db(_) => "Db",
            Self::FileType(_) => "FileType",
            Self::Watcher(_) => "Watcher",
            Self::Search(_) => "Search",
            Self::InvalidRequest(_) => "InvalidRequest",
        }
    }
}

impl Serialize for CubicalError {
    /// Serializes as `{ "code": "<variant>", "message": "<display>" }`.
    /// The frontend matches on `code`; `message` is for human-facing UI.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("CubicalError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<VaultError> for CubicalError {
    fn from(value: VaultError) -> Self {
        match value {
            VaultError::NotFound(p) => Self::VaultNotFound(p.display().to_string()),
            VaultError::NotADirectory(p) => Self::VaultNotADirectory(p.display().to_string()),
            VaultError::NotWritable(p) => Self::VaultNotWritable(p.display().to_string()),
            VaultError::Io(e) => Self::Io(e.to_string()),
            VaultError::Index(e) => Self::from(e),
            VaultError::Watcher(e) => Self::Watcher(e.to_string()),
            VaultError::ScanCancelled => Self::ScanCancelled,
            VaultError::Search(e) => Self::Search(e),
        }
    }
}

impl From<IndexError> for CubicalError {
    fn from(value: IndexError) -> Self {
        match value {
            IndexError::Io { source, .. } => Self::Io(source.to_string()),
            IndexError::LibSql(e) => Self::Db(e.to_string()),
            IndexError::SchemaTooNew(v) => Self::SchemaVersionUnsupported(v),
            // L3 Session J: surfaces when a `pending_rewrites.rewrite_kind`
            // row carries a value this build doesn't know (corrupt or
            // future-version DB). Fold into `Db` so the frontend toast
            // path stays uniform.
            other @ IndexError::UnknownEnum { .. } => Self::Db(other.to_string()),
        }
    }
}

impl From<FileTypeError> for CubicalError {
    fn from(value: FileTypeError) -> Self {
        Self::FileType(value.to_string())
    }
}

impl From<cubical_search::SearchError> for CubicalError {
    /// L4-A — direct fold of search errors into the IPC enum. The
    /// existing `VaultError::Search` path covers errors that surface
    /// through `Vault::open`; this impl covers the IPC commands that
    /// call `run_search` / index mutators directly without going
    /// through `VaultError`.
    fn from(value: cubical_search::SearchError) -> Self {
        Self::Search(value.to_string())
    }
}

impl From<libsql::Error> for CubicalError {
    fn from(value: libsql::Error) -> Self {
        Self::Db(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn vault_not_found_serializes_with_code() {
        let err: CubicalError = VaultError::NotFound(PathBuf::from("/no/such/dir")).into();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "VaultNotFound");
        assert!(
            json["message"].as_str().unwrap().contains("/no/such/dir"),
            "message should include the offending path"
        );
    }

    #[test]
    fn schema_too_new_round_trips_via_index_error() {
        let err: CubicalError = IndexError::SchemaTooNew(99).into();
        match err {
            CubicalError::SchemaVersionUnsupported(v) => assert_eq!(v, 99),
            other => panic!("expected SchemaVersionUnsupported, got {other:?}"),
        }
    }

    #[test]
    fn scan_cancelled_serializes_cleanly() {
        let err = CubicalError::ScanCancelled;
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "ScanCancelled");
    }
}
