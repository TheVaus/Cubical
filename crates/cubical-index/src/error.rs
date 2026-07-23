use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("io error opening index database at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("libsql error: {0}")]
    LibSql(#[from] libsql::Error),

    #[error(
        "on-disk schema version {0} is newer than this build supports; \
         upgrade Cubical to open this vault"
    )]
    SchemaTooNew(u32),

    #[error("unknown enum value {value:?} in {table}.{column}")]
    UnknownEnum {
        table: &'static str,
        column: &'static str,
        value: String,
    },
}
