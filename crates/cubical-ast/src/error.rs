//! Error type for AST operations.
//!
//! `parse` itself is total — frontmatter / body parsing failures are
//! either tolerated (malformed YAML degrades to "no frontmatter") or
//! impossible (`pulldown-cmark` accepts arbitrary input). This enum is
//! reserved for future fallible entry points (`parse_strict`,
//! `parse_with_options`, etc.) and for callers in `cubical-core` that
//! propagate AST failures through their own error types.

/// Errors produced by AST operations.
#[derive(Debug, thiserror::Error)]
pub enum AstError {
    /// Frontmatter YAML failed to parse. Carries the underlying error
    /// message so callers can surface it in vault-health UI (L5+).
    #[error("invalid frontmatter YAML: {0}")]
    InvalidFrontmatter(String),
}
