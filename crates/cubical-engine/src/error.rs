use serde::{Serialize, Serializer};

use cubical_core::{FileTypeError, VaultError};
use cubical_index::IndexError;

#[derive(Debug, thiserror::Error)]
pub enum CubicalError {
    #[error("vault not found: {0}")]
    VaultNotFound(String),

    #[error("vault path is not a directory: {0}")]
    VaultNotADirectory(String),

    #[error("vault path is not writable: {0}")]
    VaultNotWritable(String),

    #[error("schema version {0} is newer than this build supports")]
    SchemaVersionUnsupported(u32),

    #[error("vault not open: {0}")]
    VaultNotOpen(String),

    #[error("vault is open in another Cubical process (pid {pid})")]
    VaultLocked {
        pid: u32,
        socket_path: Option<String>,
    },

    #[error("file not found in vault: {0}")]
    FileNotFound(String),

    #[error("scan cancelled")]
    ScanCancelled,

    #[error("io error: {0}")]
    Io(String),

    #[error("database error: {0}")]
    Db(String),

    #[error("file type error: {0}")]
    FileType(String),

    #[error("watcher error: {0}")]
    Watcher(String),

    #[error("search index error: {0}")]
    Search(String),

    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("graph layout cancelled")]
    LayoutCancelled,
}

impl CubicalError {
    fn code(&self) -> &'static str {
        match self {
            Self::VaultNotFound(_) => "VaultNotFound",
            Self::VaultNotADirectory(_) => "VaultNotADirectory",
            Self::VaultNotWritable(_) => "VaultNotWritable",
            Self::SchemaVersionUnsupported(_) => "SchemaVersionUnsupported",
            Self::VaultNotOpen(_) => "VaultNotOpen",
            Self::VaultLocked { .. } => "VaultLocked",
            Self::FileNotFound(_) => "FileNotFound",
            Self::ScanCancelled => "ScanCancelled",
            Self::Io(_) => "Io",
            Self::Db(_) => "Db",
            Self::FileType(_) => "FileType",
            Self::Watcher(_) => "Watcher",
            Self::Search(_) => "Search",
            Self::InvalidRequest(_) => "InvalidRequest",
            Self::LayoutCancelled => "LayoutCancelled",
        }
    }
}

impl Serialize for CubicalError {
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
            VaultError::Settings(e) => Self::InvalidRequest(format!("settings: {e}")),
        }
    }
}

impl From<IndexError> for CubicalError {
    fn from(value: IndexError) -> Self {
        match value {
            IndexError::Io { source, .. } => Self::Io(source.to_string()),
            IndexError::LibSql(e) => Self::Db(e.to_string()),
            IndexError::SchemaTooNew(v) => Self::SchemaVersionUnsupported(v),
            other @ IndexError::UnknownEnum { .. } => Self::Db(other.to_string()),
        }
    }
}

impl From<cubical_graph::GraphError> for CubicalError {
    fn from(value: cubical_graph::GraphError) -> Self {
        match value {
            cubical_graph::GraphError::Index(e) => Self::from(e),
            cubical_graph::GraphError::Cancelled => Self::LayoutCancelled,
        }
    }
}

impl From<FileTypeError> for CubicalError {
    fn from(value: FileTypeError) -> Self {
        Self::FileType(value.to_string())
    }
}

impl From<cubical_search::SearchError> for CubicalError {
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
