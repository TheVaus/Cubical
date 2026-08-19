use cubical_index::IndexError;

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("index error: {0}")]
    Index(#[from] IndexError),
    #[error("layout cancelled")]
    Cancelled,
}

impl From<libsql::Error> for GraphError {
    fn from(source: libsql::Error) -> Self {
        GraphError::Index(IndexError::LibSql(source))
    }
}
