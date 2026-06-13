//! Error types for parsing and execution.

/// A parse failure with a human-readable message for the ⚠ widget.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ParseError {
    /// What went wrong, phrased for an end user.
    pub message: String,
}

impl ParseError {
    /// Construct a parse error from any displayable message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// A failure executing a parsed query against the index.
#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    /// The underlying libSQL driver returned an error.
    #[error("database error: {0}")]
    Db(#[from] libsql::Error),
    /// An index-layer error (e.g. opening the connection).
    #[error("index error: {0}")]
    Index(#[from] cubical_index::IndexError),
}
