use cubical_index::IndexError;

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("database error: {0}")]
    Db(#[from] libsql::Error),
    #[error("index error: {0}")]
    Index(#[from] IndexError),
    #[error("layout cancelled")]
    Cancelled,
}
