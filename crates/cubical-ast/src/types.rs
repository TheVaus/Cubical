//! Canonical Markdown AST data types.
//!
//! Designed to be slim and stable: every variant corresponds to
//! something Cubical actually produces and renders. Wiki-links, embeds,
//! block IDs, and tags will arrive at L3 — until then they ride along
//! as [`Inline::Text`] inside a [`Block::Paragraph`].
//!
//! Serialization shape (`#[derive(Serialize, Deserialize)]`) is part of
//! the IPC surface from the moment `get_canonical_ast` lands in L1
//! session B. Treat field renames as breaking changes.

use serde::{Deserialize, Serialize};

/// A half-open byte range `[start, end)` into the original source string.
///
/// Spans are recorded for block-level nodes only — inline nodes do not
/// carry spans in L1. Adding inline spans is a deliberate decision for
/// the layer that needs them (likely L2's editor mapping); it would
/// roughly double the AST's footprint without a current consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    /// Inclusive byte offset of the first byte covered by this node.
    pub start: usize,
    /// Exclusive byte offset of the byte just past the last covered byte.
    pub end: usize,
}

impl Span {
    /// Construct a span. The caller is responsible for `start <= end`.
    #[must_use]
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
}

/// A parsed markdown document.
///
/// `source_len` is the byte length of the source the document was parsed
/// from; it lets editor mapping bound-check spans cheaply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Document {
    /// YAML frontmatter, if the source had a valid `---`-delimited block
    /// at offset 0. `None` covers both "no frontmatter" and "malformed
    /// frontmatter we couldn't parse"; the malformed case is logged.
    pub frontmatter: Option<Frontmatter>,
    /// Top-level block sequence in source order.
    pub blocks: Vec<Block>,
    /// Byte length of the source the document was parsed from.
    pub source_len: usize,
}

/// YAML frontmatter, parsed into a key/value list of JSON values.
///
/// Order is preserved (YAML mappings are insertion-ordered for our
/// purposes) so callers that want to re-render frontmatter can do so
/// stably.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frontmatter {
    /// Key/value pairs in source order. Values are arbitrary JSON
    /// (scalars, lists, nested objects) so the libSQL `value` column
    /// can serialize as JSON regardless of the YAML shape.
    pub entries: Vec<(String, serde_json::Value)>,
    /// Byte span of the entire frontmatter block, including the
    /// surrounding `---` lines.
    pub span: Span,
}

/// A block-level AST node. Every variant carries a [`Span`] covering
/// the source byte range it was parsed from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    /// `# Heading` through `###### Heading`.
    Heading {
        /// 1..=6, validated by the parser.
        level: u8,
        /// Inline children making up the heading text.
        inlines: Vec<Inline>,
        /// Source span.
        span: Span,
    },
    /// A paragraph of inline content.
    Paragraph {
        /// Inline children in source order.
        inlines: Vec<Inline>,
        /// Source span.
        span: Span,
    },
    /// An ordered or unordered list. Each item is itself a sequence
    /// of blocks (`pulldown-cmark`-style — list items can hold
    /// paragraphs, sub-lists, code blocks, etc.).
    List {
        /// `true` for ordered (`1.`, `2.`, ...); `false` for bullet.
        ordered: bool,
        /// Items in source order.
        items: Vec<ListItem>,
        /// Source span covering the whole list.
        span: Span,
    },
    /// A fenced or indented code block.
    CodeBlock {
        /// Info string after the opening fence (e.g. `rust`), or
        /// `None` for indented code blocks.
        lang: Option<String>,
        /// Verbatim block contents, newlines preserved.
        content: String,
        /// Source span.
        span: Span,
    },
    /// A blockquote. Quotes recursively contain blocks.
    Quote {
        /// Nested block sequence in source order.
        blocks: Vec<Block>,
        /// Source span.
        span: Span,
    },
    /// A `---` / `***` / `___` thematic break.
    ThematicBreak {
        /// Source span.
        span: Span,
    },
    /// Raw HTML passthrough. Pulldown-cmark surfaces this as a
    /// distinct block kind; we preserve it verbatim.
    Html {
        /// HTML content as it appeared in source.
        content: String,
        /// Source span.
        span: Span,
    },
}

/// One item inside a [`Block::List`].
///
/// A list item is a sequence of blocks — pulldown-cmark wraps loose
/// list items in their own paragraphs and tight items in a single
/// paragraph; both shapes flow through here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListItem {
    /// Block sequence inside the item, in source order.
    pub blocks: Vec<Block>,
    /// Source span covering the whole item.
    pub span: Span,
}

/// An inline-level AST node. Inlines do not carry spans in L1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Inline {
    /// Plain text. Soft line breaks are folded into a single space
    /// inside the surrounding text run; hard breaks are explicit
    /// [`Inline::LineBreak`]s.
    Text(String),
    /// `*emph*` / `_emph_`.
    Emph(Vec<Inline>),
    /// `**strong**` / `__strong__`.
    Strong(Vec<Inline>),
    /// `` `code` `` — inline code span.
    Code(String),
    /// `[text](dest "title")`.
    Link {
        /// Link destination URL.
        dest: String,
        /// Optional title attribute.
        title: Option<String>,
        /// Children making up the link text.
        children: Vec<Inline>,
    },
    /// `![alt](dest "title")`.
    Image {
        /// Image source URL.
        dest: String,
        /// Optional title attribute.
        title: Option<String>,
        /// Children making up the alt text.
        alt: Vec<Inline>,
    },
    /// Hard line break (two trailing spaces or `\` at end of line).
    /// Soft breaks are not represented — they fold into the
    /// surrounding [`Inline::Text`].
    LineBreak,
}
