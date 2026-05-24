//! Extract wiki-link occurrences from a parsed `cubical_ast::Document`.
//!
//! Pure: takes only the parsed document; emits one `LinkExtraction`
//! per `Inline::WikiLink` in source order. Resolution to a vault path
//! happens in the caller (the scan/watcher pipeline), which has the
//! file-list context the extractor lacks.

use cubical_ast::{Anchor, Block, Document, Inline, ListItem};

/// One wiki-link occurrence extracted from a `Document`.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkExtraction {
    /// The wiki-link target as written, with surrounding whitespace
    /// trimmed.
    pub target_raw: String,
    /// The parsed anchor, if any.
    pub anchor: Option<Anchor>,
    /// The optional `|display` text.
    pub display: Option<String>,
    /// `true` when the link was written `![[…]]`.
    pub is_embed: bool,
    /// Byte offset into the original source where the wiki-link occurs.
    /// In Session A this is the start of the enclosing block's span —
    /// per-inline byte spans are post-L1 work. Good enough for the
    /// link index to order rows by appearance.
    pub position: u64,
}

/// Walk every block + inline tree in `doc` and yield the wiki-link
/// occurrences in source order.
pub fn extract_links(doc: &Document) -> Vec<LinkExtraction> {
    let mut out = Vec::new();
    for block in &doc.blocks {
        walk_block(block, &mut out);
    }
    out
}

fn walk_block(block: &Block, out: &mut Vec<LinkExtraction>) {
    match block {
        Block::Heading { inlines, span, .. } => walk_inlines(inlines, span.start as u64, out),
        Block::Paragraph { inlines, span } => walk_inlines(inlines, span.start as u64, out),
        Block::List { items, .. } => {
            for ListItem { blocks, .. } in items {
                for sub in blocks {
                    walk_block(sub, out);
                }
            }
        }
        Block::Quote { blocks, .. } => {
            for sub in blocks {
                walk_block(sub, out);
            }
        }
        Block::CodeBlock { .. } | Block::ThematicBreak { .. } | Block::Html { .. } => {}
    }
}

fn walk_inlines(inlines: &[Inline], pos: u64, out: &mut Vec<LinkExtraction>) {
    for inline in inlines {
        match inline {
            Inline::WikiLink {
                target,
                display,
                anchor,
                embed,
            } => {
                out.push(LinkExtraction {
                    target_raw: target.clone(),
                    anchor: anchor.clone(),
                    display: display.clone(),
                    is_embed: *embed,
                    position: pos,
                });
            }
            Inline::Emph { children } | Inline::Strong { children } => {
                walk_inlines(children, pos, out);
            }
            Inline::Link { children, .. } => walk_inlines(children, pos, out),
            Inline::Image { alt, .. } => walk_inlines(alt, pos, out),
            Inline::Text { .. } | Inline::Code { .. } | Inline::LineBreak => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_ast::parse;

    #[test]
    fn extracts_simple_wikilink() {
        let doc = parse("see [[note]] for context\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "note");
        assert!(links[0].anchor.is_none());
        assert!(!links[0].is_embed);
    }

    #[test]
    fn extracts_embed_and_anchor() {
        let doc = parse("![[diagram]] and [[note#^id]]\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 2);
        assert!(links[0].is_embed);
        assert!(matches!(links[1].anchor, Some(Anchor::Block { .. })));
    }

    #[test]
    fn extracts_from_headings_and_quotes() {
        let doc = parse("# Heading with [[link]]\n\n> quote with [[other]]\n");
        let links = extract_links(&doc);
        let targets: Vec<&str> = links.iter().map(|l| l.target_raw.as_str()).collect();
        assert_eq!(targets, vec!["link", "other"]);
    }

    #[test]
    fn no_wikilinks_returns_empty() {
        let doc = parse("# plain heading\n\nplain paragraph.\n");
        assert!(extract_links(&doc).is_empty());
    }

    #[test]
    fn extracts_from_list_items() {
        let doc = parse("- item with [[a]]\n- another [[b]]\n");
        let links = extract_links(&doc);
        let targets: Vec<&str> = links.iter().map(|l| l.target_raw.as_str()).collect();
        assert_eq!(targets, vec!["a", "b"]);
    }
}
