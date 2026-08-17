use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    #[must_use]
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Document {
    pub frontmatter: Option<Frontmatter>,
    pub blocks: Vec<Block>,
    pub source_len: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frontmatter {
    pub entries: Vec<(String, serde_json::Value)>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    Heading {
        level: u8,
        inlines: Vec<Inline>,
        span: Span,
    },
    Paragraph {
        inlines: Vec<Inline>,
        span: Span,
    },
    List {
        ordered: bool,
        items: Vec<ListItem>,
        span: Span,
    },
    CodeBlock {
        lang: Option<String>,
        content: String,
        span: Span,
    },
    Quote {
        blocks: Vec<Block>,
        span: Span,
    },
    ThematicBreak {
        span: Span,
    },
    Html {
        content: String,
        span: Span,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListItem {
    pub blocks: Vec<Block>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Anchor {
    Heading { value: String },
    Block { value: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Inline {
    Text {
        value: String,
    },
    Emph {
        children: Vec<Inline>,
    },
    Strong {
        children: Vec<Inline>,
    },
    Code {
        value: String,
    },
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
    LineBreak,
    WikiLink {
        target: String,
        display: Option<String>,
        anchor: Option<Anchor>,
        embed: bool,
    },
    PropertyRef {
        note: Option<String>,
        property: String,
    },
    Tag {
        path: String,
    },
}
