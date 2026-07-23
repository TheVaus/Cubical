use thiserror::Error;

#[derive(Debug, Error)]
pub enum SearchError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("tantivy: {0}")]
    Tantivy(#[from] tantivy::TantivyError),

    #[error("query parse: {0}")]
    QueryParse(String),

    #[error("limit {got} exceeds maximum of {max}")]
    LimitTooLarge { got: usize, max: usize },

    #[error("schema.json: {0}")]
    SchemaJson(#[from] serde_json::Error),

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
