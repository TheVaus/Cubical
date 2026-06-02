//! `cubical-search` — Tantivy wrapper.
//!
//! Full-text search over the canonical AST. One Tantivy document per
//! `.md` file with structural fields (`title`, `headings`, `body`,
//! `code`, `tags`, `frontmatter`). See
//! `docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod doc;
pub mod error;
pub mod index;
pub mod query;
pub mod schema;
pub mod status;

// Re-exports are restored as each module is fleshed out in later tasks.
pub use doc::IndexDoc;
pub use error::SearchError;
pub use index::SearchIndex;
// TODO(l4-a Task 8): pub use query::{FieldScope, MatchedField, SearchHit, SearchQuery, SearchResponse, SortMode};
// TODO(l4-a Task 7): pub use status::{IndexHealth, IndexState, IndexStatus};
