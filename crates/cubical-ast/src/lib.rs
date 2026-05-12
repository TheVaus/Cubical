//! `cubical-ast` — the canonical Markdown AST.
//!
//! This crate defines the AST data types and a `parse` entry point that
//! turns a markdown source string into a [`Document`]. Lezer trees from
//! the editor are normalized into the same shape on the Rust side
//! (post-L1 session B); indexers, link resolvers, and exporters consume
//! [`Document`] values directly.
//!
//! The AST is intentionally slim: only nodes Cubical itself produces.
//! Cross-app importers (Obsidian, Logseq, Notion) are out of v1 scope,
//! so extension nodes (math, mermaid, callouts, footnotes, tables,
//! definition lists) are absent. Wiki-links, embeds, block IDs, and
//! tags will be recognized in L3 — until then they pass through as
//! plain [`Inline::Text`].
//!
//! See `docs/architecture/document-model.md` — "Canonical AST".
//!
//! ## Public surface
//!
//! - [`Document`], [`Block`], [`ListItem`], [`Inline`], [`Span`],
//!   [`Frontmatter`] — the AST data types.
//! - [`parse`] — the single entry point. Wraps `pulldown-cmark` and
//!   layers strict YAML frontmatter detection on top.
//! - [`split_frontmatter`] — helper that separates the frontmatter
//!   block (if any) from the body, exposed for callers that want to
//!   re-render the body without re-tokenizing.
//! - [`AstError`] — error type for parsing failures. Folded into
//!   `CubicalError` at the IPC boundary.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod error;
mod frontmatter;
mod normalize;
mod types;

pub use error::AstError;
pub use frontmatter::split_frontmatter;
pub use types::{Block, Document, Frontmatter, Inline, ListItem, Span};

/// Parse `source` into a canonical [`Document`].
///
/// Detects strict YAML frontmatter at byte offset 0 (an opening `---`
/// on the very first line, no leading whitespace, paired with a closing
/// `---` on its own line). Malformed YAML between the markers logs a
/// `tracing::warn!` and produces [`Document::frontmatter`] = `None` —
/// the body is parsed normally either way.
///
/// The body is parsed via `pulldown-cmark` and normalized into the
/// canonical AST. Block-level spans are byte offsets into the original
/// `source` string (frontmatter included), suitable for editor
/// mapping at L2.
///
/// This function is total: it never returns an error. Future
/// fallibility (e.g. an `AstError` for catastrophic parser misuse)
/// would be added behind a `parse_strict`-style entry point rather
/// than changing this signature.
#[must_use]
pub fn parse(source: &str) -> Document {
    let (yaml_opt, body, body_offset) = frontmatter::split_with_offset(source);
    let frontmatter = yaml_opt.and_then(|yaml_str| {
        frontmatter::parse_with_span(yaml_str, body_offset).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "malformed YAML frontmatter; treating as none");
            None
        })
    });
    let blocks = normalize::normalize(body, body_offset);
    Document {
        frontmatter,
        blocks,
        source_len: source.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_is_idempotent() {
        let src = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Heading\n\nBody.\n";
        let a = parse(src);
        let b = parse(src);
        assert_eq!(a, b);
    }

    #[test]
    fn parse_empty_source_returns_empty_doc() {
        let doc = parse("");
        assert!(doc.frontmatter.is_none());
        assert!(doc.blocks.is_empty());
        assert_eq!(doc.source_len, 0);
    }

    #[test]
    fn parse_no_frontmatter_records_none() {
        let doc = parse("# Just a heading\n");
        assert!(doc.frontmatter.is_none());
        assert_eq!(doc.blocks.len(), 1);
    }

    /// Documents must round-trip through serde_json so the IPC layer
    /// can ship them to the frontend. This test specifically guards
    /// against a regression where `Inline::Text` / `Inline::Code`
    /// were tuple variants on an internally tagged enum — a shape
    /// `serde_json` panics on at serialization time.
    #[test]
    fn document_round_trips_through_serde_json() {
        let src = "---\ntitle: x\n---\n\n# Heading `code` *emph*\n\n[label](u) ![alt](p)\n";
        let doc = parse(src);
        let s = serde_json::to_string(&doc).expect("serialize");
        let back: Document = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(doc, back);
    }
}
