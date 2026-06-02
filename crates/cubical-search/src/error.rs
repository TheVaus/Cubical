//! Error type for `cubical-search`.

use thiserror::Error;

/// Errors produced by the Tantivy wrapper.
#[derive(Debug, Error)]
pub enum SearchError {
    /// I/O failure (open, persist, schema.json read/write).
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Tantivy library error (open, commit, search, parse).
    #[error("tantivy: {0}")]
    Tantivy(#[from] tantivy::TantivyError),

    /// `QueryParser` rejected the user-supplied query string.
    #[error("query parse: {0}")]
    QueryParse(String),

    /// `SearchQuery.limit` exceeded the hard cap of 500.
    #[error("limit {got} exceeds maximum of {max}")]
    LimitTooLarge {
        /// What the caller asked for.
        got: usize,
        /// The hard cap (500).
        max: usize,
    },

    /// JSON failure reading/writing `schema.json`.
    #[error("schema.json: {0}")]
    SchemaJson(#[from] serde_json::Error),

    /// Internal poisoning of the writer mutex (should be unreachable in
    /// practice — surfaced as an `IpcError::Internal` upstream).
    #[error("search writer poisoned")]
    WriterPoisoned,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_too_large_display() {
        let e = SearchError::LimitTooLarge {
            got: 1000,
            max: 500,
        };
        assert_eq!(e.to_string(), "limit 1000 exceeds maximum of 500");
    }
}
