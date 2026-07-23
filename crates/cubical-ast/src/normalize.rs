use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use crate::types::{Block, Inline, ListItem, Span};

pub(crate) fn normalize(body: &str, body_offset: usize) -> Vec<Block> {
    let parser = Parser::new_ext(body, Options::empty()).into_offset_iter();
    let mut state = State::new(body_offset);
    for (event, range) in parser {
        state.consume(event, range);
    }
    state.finish()
}

enum Container {
    Doc(Vec<Block>),
    Heading {
        level: u8,
        inlines: Vec<Inline>,
        start: usize,
    },
    Paragraph {
        inlines: Vec<Inline>,
        start: usize,
    },
    BlockQuote {
        blocks: Vec<Block>,
        start: usize,
    },
    List {
        ordered: bool,
        items: Vec<ListItem>,
        start: usize,
    },
    Item {
        blocks: Vec<Block>,
        start: usize,
    },
    Emph(Vec<Inline>),
    Strong(Vec<Inline>),
    Link {
        dest: String,
        title: Option<String>,
        children: Vec<Inline>,
    },
    Image {
        dest: String,
        title: Option<String>,
        alt: Vec<Inline>,
    },
    CodeBlockBody {
        lang: Option<String>,
        content: String,
        start: usize,
    },
    HtmlBlock {
        content: String,
        start: usize,
    },
    Swallow,
}

struct State {
    body_offset: usize,
    stack: Vec<Container>,
}

impl State {
    fn new(body_offset: usize) -> Self {
        Self {
            body_offset,
            stack: vec![Container::Doc(Vec::new())],
        }
    }

    fn consume(&mut self, event: Event<'_>, range: std::ops::Range<usize>) {
        match event {
            Event::Start(tag) => self.start(tag, range),
            Event::End(tag) => self.end(tag, range),
            Event::Text(s) => self.push_inline(Inline::Text {
                value: s.to_string(),
            }),
            Event::Code(s) => self.push_inline(Inline::Code {
                value: s.to_string(),
            }),
            Event::SoftBreak => {
                self.push_inline(Inline::Text {
                    value: " ".to_string(),
                });
            }
            Event::HardBreak => self.push_inline(Inline::LineBreak),
            Event::Html(s) | Event::InlineHtml(s) => {
                if let Some(Container::HtmlBlock { content, .. }) = self.stack.last_mut() {
                    content.push_str(&s);
                } else if self.is_inline_context() {
                    self.push_inline(Inline::Text {
                        value: s.to_string(),
                    });
                } else {
                    self.push_block(Block::Html {
                        content: s.to_string(),
                        span: self.shift(range),
                    });
                }
            }
            Event::Rule => {
                self.push_block(Block::ThematicBreak {
                    span: self.shift(range),
                });
            }
            Event::TaskListMarker(_)
            | Event::FootnoteReference(_)
            | Event::DisplayMath(_)
            | Event::InlineMath(_) => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>, range: std::ops::Range<usize>) {
        if !matches!(
            tag,
            Tag::Emphasis
                | Tag::Strong
                | Tag::Link { .. }
                | Tag::Image { .. }
                | Tag::Strikethrough
                | Tag::Superscript
                | Tag::Subscript
        ) {
            self.close_implicit_paragraph_in_item();
        }
        match tag {
            Tag::Paragraph => self.stack.push(Container::Paragraph {
                inlines: Vec::new(),
                start: range.start,
            }),
            Tag::Heading { level, .. } => self.stack.push(Container::Heading {
                level: heading_level_to_u8(level),
                inlines: Vec::new(),
                start: range.start,
            }),
            Tag::BlockQuote(_) => self.stack.push(Container::BlockQuote {
                blocks: Vec::new(),
                start: range.start,
            }),
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Indented => None,
                    CodeBlockKind::Fenced(info) => {
                        let info = info.trim();
                        if info.is_empty() {
                            None
                        } else {
                            Some(info.to_string())
                        }
                    }
                };
                self.stack.push(Container::CodeBlockBody {
                    lang,
                    content: String::new(),
                    start: range.start,
                });
            }
            Tag::List(start) => self.stack.push(Container::List {
                ordered: start.is_some(),
                items: Vec::new(),
                start: range.start,
            }),
            Tag::Item => self.stack.push(Container::Item {
                blocks: Vec::new(),
                start: range.start,
            }),
            Tag::Emphasis => self.stack.push(Container::Emph(Vec::new())),
            Tag::Strong => self.stack.push(Container::Strong(Vec::new())),
            Tag::Link {
                dest_url, title, ..
            } => self.stack.push(Container::Link {
                dest: dest_url.to_string(),
                title: option_string(title.to_string()),
                children: Vec::new(),
            }),
            Tag::Image {
                dest_url, title, ..
            } => self.stack.push(Container::Image {
                dest: dest_url.to_string(),
                title: option_string(title.to_string()),
                alt: Vec::new(),
            }),
            Tag::HtmlBlock => self.stack.push(Container::HtmlBlock {
                content: String::new(),
                start: range.start,
            }),
            Tag::FootnoteDefinition(_)
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell
            | Tag::Strikethrough
            | Tag::Superscript
            | Tag::Subscript
            | Tag::MetadataBlock(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition => {
                self.stack.push(Container::Swallow);
            }
        }
    }

    fn end(&mut self, tag: TagEnd, range: std::ops::Range<usize>) {
        if matches!(tag, TagEnd::Item) {
            self.close_implicit_paragraph_in_item();
        }
        let Some(top) = self.stack.pop() else {
            return;
        };
        match top {
            Container::Doc(_) => {
                self.stack.push(Container::Doc(Vec::new()));
            }
            Container::Heading {
                level,
                inlines,
                start,
            } => {
                self.push_block(Block::Heading {
                    level,
                    inlines: split_inlines(inlines),
                    span: self.shift(start..range.end),
                });
            }
            Container::Paragraph { inlines, start } => {
                self.push_block(Block::Paragraph {
                    inlines: split_inlines(inlines),
                    span: self.shift(start..range.end),
                });
            }
            Container::BlockQuote { blocks, start } => {
                self.push_block(Block::Quote {
                    blocks,
                    span: self.shift(start..range.end),
                });
            }
            Container::CodeBlockBody {
                lang,
                content,
                start,
            } => {
                self.push_block(Block::CodeBlock {
                    lang,
                    content,
                    span: self.shift(start..range.end),
                });
            }
            Container::List {
                ordered,
                items,
                start,
            } => {
                self.push_block(Block::List {
                    ordered,
                    items,
                    span: self.shift(start..range.end),
                });
            }
            Container::Item { blocks, start } => {
                let item = ListItem {
                    blocks,
                    span: self.shift(start..range.end),
                };
                if let Some(Container::List { items, .. }) = self.stack.last_mut() {
                    items.push(item);
                }
            }
            Container::Emph(children) => self.push_inline(Inline::Emph { children }),
            Container::Strong(children) => self.push_inline(Inline::Strong { children }),
            Container::Link {
                dest,
                title,
                children,
            } => {
                self.push_inline(Inline::Link {
                    dest,
                    title,
                    children,
                });
            }
            Container::Image { dest, title, alt } => {
                self.push_inline(Inline::Image { dest, title, alt });
            }
            Container::HtmlBlock { content, start } => {
                self.push_block(Block::Html {
                    content,
                    span: self.shift(start..range.end),
                });
            }
            Container::Swallow => {}
        }
    }

    fn push_block(&mut self, block: Block) {
        match self.stack.last_mut() {
            Some(Container::Doc(blocks))
            | Some(Container::BlockQuote { blocks, .. })
            | Some(Container::Item { blocks, .. }) => {
                blocks.push(block);
            }
            _ => {}
        }
    }

    fn push_inline(&mut self, inline: Inline) {
        if let Some(Container::CodeBlockBody { content, .. }) = self.stack.last_mut() {
            if let Inline::Text { value } = inline {
                content.push_str(&value);
            }
            return;
        }

        if matches!(self.stack.last(), Some(Container::Item { .. })) {
            self.stack.push(Container::Paragraph {
                inlines: Vec::new(),
                start: 0,
            });
        }

        let target: Option<&mut Vec<Inline>> = match self.stack.last_mut() {
            Some(Container::Heading { inlines, .. })
            | Some(Container::Paragraph { inlines, .. }) => Some(inlines),
            Some(Container::Emph(children)) | Some(Container::Strong(children)) => Some(children),
            Some(Container::Link { children, .. }) => Some(children),
            Some(Container::Image { alt, .. }) => Some(alt),
            _ => None,
        };
        if let Some(v) = target {
            if let Inline::Text { value: s } = &inline {
                if let Some(Inline::Text { value: prev }) = v.last_mut() {
                    prev.push_str(s);
                    return;
                }
            }
            v.push(inline);
        }
    }

    fn close_implicit_paragraph_in_item(&mut self) {
        let n = self.stack.len();
        if n < 2 {
            return;
        }
        let is_para_under_item = matches!(self.stack[n - 1], Container::Paragraph { .. })
            && matches!(self.stack[n - 2], Container::Item { .. });
        if !is_para_under_item {
            return;
        }
        let Some(Container::Paragraph { inlines, start: _ }) = self.stack.pop() else {
            return;
        };
        let item_start = match self.stack.last() {
            Some(Container::Item { start, .. }) => *start,
            _ => 0,
        };
        if let Some(Container::Item { blocks, .. }) = self.stack.last_mut() {
            blocks.push(Block::Paragraph {
                inlines: split_inlines(inlines),
                span: Span::new(item_start + self.body_offset, item_start + self.body_offset),
            });
        }
    }

    fn is_inline_context(&self) -> bool {
        matches!(
            self.stack.last(),
            Some(Container::Heading { .. })
                | Some(Container::Paragraph { .. })
                | Some(Container::Emph(_))
                | Some(Container::Strong(_))
                | Some(Container::Link { .. })
                | Some(Container::Image { .. })
        )
    }

    fn shift(&self, range: std::ops::Range<usize>) -> Span {
        Span::new(range.start + self.body_offset, range.end + self.body_offset)
    }

    fn finish(mut self) -> Vec<Block> {
        match self.stack.pop() {
            Some(Container::Doc(blocks)) => blocks,
            _ => Vec::new(),
        }
    }
}

fn split_inlines(inlines: Vec<Inline>) -> Vec<Inline> {
    use crate::tag::{scan_tags, TokenizedRun as TagRun};
    use crate::wikilink::{scan_wikilinks, TokenizedRun as WikiRun};
    let mut out: Vec<Inline> = Vec::with_capacity(inlines.len());
    let push_text_split_by_tags = |out: &mut Vec<Inline>, text: String| {
        for run in scan_tags(&text) {
            match run {
                TagRun::Text(t) => out.push(Inline::Text { value: t }),
                TagRun::Tag { path } => out.push(Inline::Tag { path }),
            }
        }
    };
    for inline in inlines {
        match inline {
            Inline::Text { value } => {
                for run in scan_wikilinks(&value) {
                    match run {
                        WikiRun::Text(t) => push_text_split_by_tags(&mut out, t),
                        WikiRun::WikiLink {
                            target,
                            display,
                            anchor,
                            embed,
                        } => {
                            out.push(Inline::WikiLink {
                                target,
                                display,
                                anchor,
                                embed,
                            });
                        }
                        WikiRun::PropertyRef { note, property } => {
                            out.push(Inline::PropertyRef { note, property });
                        }
                    }
                }
            }
            Inline::Emph { children } => out.push(Inline::Emph {
                children: split_inlines(children),
            }),
            Inline::Strong { children } => out.push(Inline::Strong {
                children: split_inlines(children),
            }),
            Inline::Link {
                dest,
                title,
                children,
            } => out.push(Inline::Link {
                dest,
                title,
                children: split_inlines(children),
            }),
            Inline::Image { dest, title, alt } => out.push(Inline::Image {
                dest,
                title,
                alt: split_inlines(alt),
            }),
            other => out.push(other),
        }
    }
    out
}

fn heading_level_to_u8(level: pulldown_cmark::HeadingLevel) -> u8 {
    use pulldown_cmark::HeadingLevel;
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn option_string(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    #[test]
    fn heading_and_paragraph() {
        let doc = parse("# Hello\n\nA paragraph.\n");
        assert_eq!(doc.blocks.len(), 2);
        match &doc.blocks[0] {
            Block::Heading {
                level,
                inlines,
                span,
            } => {
                assert_eq!(*level, 1);
                assert_eq!(inlines.len(), 1);
                assert!(matches!(&inlines[0], Inline::Text { value } if value == "Hello"));
                assert_eq!(span.start, 0);
                assert!(span.end >= 7);
            }
            other => panic!("expected heading, got {other:?}"),
        }
        assert!(matches!(&doc.blocks[1], Block::Paragraph { .. }));
    }

    #[test]
    fn fenced_code_block_preserves_lang_and_content() {
        let src = "```rust\nfn main() {}\n```\n";
        let doc = parse(src);
        assert_eq!(doc.blocks.len(), 1);
        match &doc.blocks[0] {
            Block::CodeBlock { lang, content, .. } => {
                assert_eq!(lang.as_deref(), Some("rust"));
                assert_eq!(content, "fn main() {}\n");
            }
            other => panic!("expected code block, got {other:?}"),
        }
    }

    #[test]
    fn nested_lists_recurse_through_blocks() {
        let src = "- outer 1\n  - inner a\n  - inner b\n- outer 2\n";
        let doc = parse(src);
        assert_eq!(doc.blocks.len(), 1);
        let Block::List {
            ordered,
            items,
            span,
        } = &doc.blocks[0]
        else {
            panic!("expected list");
        };
        assert!(!ordered);
        assert_eq!(items.len(), 2);
        assert!(span.end > span.start);
        let first = &items[0];
        assert!(first
            .blocks
            .iter()
            .any(|b| matches!(b, Block::Paragraph { .. })));
        assert!(first.blocks.iter().any(|b| matches!(b, Block::List { .. })));
    }

    #[test]
    fn ordered_list_marker_round_trips() {
        let doc = parse("1. one\n2. two\n");
        assert!(matches!(&doc.blocks[0], Block::List { ordered: true, .. }));
    }

    #[test]
    fn blockquote_recurses() {
        let doc = parse("> quoted\n> still quoted\n");
        assert_eq!(doc.blocks.len(), 1);
        let Block::Quote { blocks, .. } = &doc.blocks[0] else {
            panic!("expected quote");
        };
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], Block::Paragraph { .. }));
    }

    #[test]
    fn thematic_break() {
        let doc = parse("---\n");
        assert!(doc
            .blocks
            .iter()
            .any(|b| matches!(b, Block::ThematicBreak { .. })));
    }

    #[test]
    fn html_block_is_passthrough() {
        let src = "<div class=\"x\">hi</div>\n";
        let doc = parse(src);
        assert!(doc
            .blocks
            .iter()
            .any(|b| matches!(b, Block::Html { content, .. } if content.contains("div"))));
    }

    #[test]
    fn emph_strong_link_image_inlines_round_trip() {
        let src = "*emph* **strong** `code` [label](https://x.test \"t\") ![alt](pic.png)\n";
        let doc = parse(src);
        let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
            panic!("expected paragraph");
        };
        let kinds: Vec<&str> = inlines
            .iter()
            .map(|i| match i {
                Inline::Text { .. } => "text",
                Inline::Emph { .. } => "emph",
                Inline::Strong { .. } => "strong",
                Inline::Code { .. } => "code",
                Inline::Link { .. } => "link",
                Inline::Image { .. } => "image",
                Inline::LineBreak => "break",
                Inline::WikiLink { .. } => "wiki_link",
                Inline::PropertyRef { .. } => "property_ref",
                Inline::Tag { .. } => "tag",
            })
            .collect();
        assert!(kinds.contains(&"emph"));
        assert!(kinds.contains(&"strong"));
        assert!(kinds.contains(&"code"));
        assert!(kinds.contains(&"link"));
        assert!(kinds.contains(&"image"));

        let link = inlines
            .iter()
            .find_map(|i| match i {
                Inline::Link {
                    dest,
                    title,
                    children,
                } => Some((dest, title, children)),
                _ => None,
            })
            .unwrap();
        assert_eq!(link.0, "https://x.test");
        assert_eq!(link.1.as_deref(), Some("t"));
        assert!(matches!(&link.2[0], Inline::Text { value } if value == "label"));
    }

    #[test]
    fn hard_break_is_emitted() {
        let src = "line one  \nline two\n";
        let doc = parse(src);
        let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
            panic!("expected paragraph");
        };
        assert!(inlines.iter().any(|i| matches!(i, Inline::LineBreak)));
    }

    #[test]
    fn property_refs_become_inline_nodes() {
        let doc = parse("Age: [[Gandalf.age]] and [[.level]].\n");
        let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
            panic!("expected paragraph");
        };
        let refs: Vec<(Option<&str>, &str)> = inlines
            .iter()
            .filter_map(|i| match i {
                Inline::PropertyRef { note, property } => {
                    Some((note.as_deref(), property.as_str()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(refs, vec![(Some("Gandalf"), "age"), (None, "level")]);
    }

    #[test]
    fn block_spans_cover_source_ranges_in_absolute_offsets() {
        let src = "---\ntitle: x\n---\n\n# Heading\n\nBody.\n";
        let doc = parse(src);
        let fm = doc.frontmatter.as_ref().unwrap();
        assert_eq!(fm.span.start, 0);
        let first_span = match &doc.blocks[0] {
            Block::Heading { span, .. } => span,
            other => panic!("expected heading, got {other:?}"),
        };
        assert!(first_span.start >= fm.span.end);
        assert!(first_span.end <= src.len());
    }
}
