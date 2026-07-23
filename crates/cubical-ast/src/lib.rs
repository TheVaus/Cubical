#![forbid(unsafe_code)]

mod error;
pub mod frontmatter;
mod normalize;
pub mod tag;
mod types;
pub mod wikilink;

pub use error::AstError;
pub use frontmatter::{parse_frontmatter, split_frontmatter};
pub use types::{Anchor, Block, Document, Frontmatter, Inline, ListItem, Span};
pub use wikilink::{scan_wikilinks, TokenizedRun};

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

    #[test]
    fn wikilink_in_paragraph_is_extracted() {
        use crate::types::{Block, Inline};
        let doc = parse("see [[Other Note]] for more\n");
        assert_eq!(doc.blocks.len(), 1);
        let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
            panic!("expected paragraph, got {:?}", doc.blocks[0]);
        };
        assert_eq!(inlines.len(), 3);
        assert!(matches!(&inlines[0], Inline::Text { value } if value == "see "));
        assert!(matches!(
            &inlines[1],
            Inline::WikiLink { target, display: None, anchor: None, embed: false }
                if target == "Other Note"
        ));
        assert!(matches!(&inlines[2], Inline::Text { value } if value == " for more"));
    }

    #[test]
    fn embed_wikilink_in_paragraph() {
        use crate::types::{Block, Inline};
        let doc = parse("![[diagram]]\n");
        let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
            panic!("expected paragraph")
        };
        assert_eq!(inlines.len(), 1);
        assert!(matches!(&inlines[0], Inline::WikiLink { embed: true, .. }));
    }

    #[test]
    fn inline_code_text_is_not_scanned_for_wikilinks() {
        use crate::types::{Block, Inline};
        let doc = parse("see `[[not a link]]` here\n");
        let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
            panic!("expected paragraph")
        };
        assert!(
            inlines
                .iter()
                .any(|n| matches!(n, Inline::Code { value } if value == "[[not a link]]")),
            "code span content must be preserved: {:?}",
            inlines
        );
        assert!(
            !inlines.iter().any(|n| matches!(n, Inline::WikiLink { .. })),
            "no WikiLink should be produced from inline-code content: {:?}",
            inlines
        );
    }

    #[test]
    fn wikilink_round_trips_through_serde_json() {
        use crate::types::{Anchor, Inline};
        let wl = Inline::WikiLink {
            target: "Some Note".into(),
            display: Some("see here".into()),
            anchor: Some(Anchor::Block {
                value: "intro".into(),
            }),
            embed: false,
        };
        let s = serde_json::to_string(&wl).expect("serialize");
        let back: Inline = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(wl, back);
        assert!(s.contains("\"kind\":\"wiki_link\""));
    }

    #[test]
    fn document_round_trips_through_serde_json() {
        let src = "---\ntitle: x\n---\n\n# Heading `code` *emph*\n\n[label](u) ![alt](p)\n";
        let doc = parse(src);
        let s = serde_json::to_string(&doc).expect("serialize");
        let back: Document = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(doc, back);
    }
}
