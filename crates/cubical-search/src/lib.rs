#![forbid(unsafe_code)]

pub mod doc;
pub mod error;
pub mod index;
pub mod query;
pub mod schema;
pub mod status;

pub use doc::IndexDoc;
pub use error::SearchError;
pub use index::SearchIndex;
pub use query::{FieldScope, MatchedField, SearchHit, SearchQuery, SearchResponse, SortMode};
pub use status::{IndexHealth, IndexState, IndexStatus};
