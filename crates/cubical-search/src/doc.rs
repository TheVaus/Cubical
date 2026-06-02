//! Project an on-disk markdown file into Tantivy fields.

use cubical_ast::{frontmatter::parse_frontmatter, parse, Block, Document, Inline};

/// Projection of one `.md` file into the search schema.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexDoc {
    /// Vault-relative path.
    pub path: String,
    /// Frontmatter `title` if a string scalar; else filename stem.
    pub title: String,
    /// Concatenated heading text.
    pub headings: String,
    /// Prose body (Task 5 fills this).
    pub body: String,
    /// Fenced + inline code text (Task 5 fills this).
    pub code: String,
    /// Lowercased tag strings.
    pub tags: Vec<String>,
    /// Flattened frontmatter scalars (`key value` pairs), excluding `title` and `tags`.
    pub frontmatter: String,
    /// File mtime in unix seconds.
    pub mtime_secs: i64,
    /// File size in bytes.
    pub size_bytes: u64,
}

/// Build the simple fields from raw source + filesystem metadata. The
/// AST is parsed locally so the caller hands only `(path, source, mtime, size)`.
///
/// `tags` are collected from frontmatter `tags:` plus inline `#tag`
/// occurrences (from `Inline::Tag` nodes during the AST walk; frontmatter
/// is excluded by construction since `cubical_ast::parse` splits it off
/// before block parsing). They are lowercased at projection time so the
/// `tag:` field-prefix query parses to the same form as the indexed value.
#[must_use]
pub fn project(path: &str, source: &str, mtime_secs: i64, size_bytes: u64) -> IndexDoc {
    let doc = parse(source);
    let title = derive_title(path, &doc, source);
    let mut walker = Walker::default();
    walker.walk_blocks(&doc.blocks);
    let tags = collect_tags(&doc, source, &walker.tags);
    let frontmatter = flatten_frontmatter(source);
    let headings = walker.finish_headings();
    let body = walker.finish_body();
    let code = walker.finish_code();
    IndexDoc {
        path: path.to_string(),
        title,
        headings,
        body,
        code,
        tags,
        frontmatter,
        mtime_secs,
        size_bytes,
    }
}

fn derive_title(path: &str, _doc: &Document, source: &str) -> String {
    if let Some(fm) = parse_frontmatter(source) {
        if let Some(t) = fm.get_string("title") {
            return t.to_string();
        }
    }
    // Fallback: filename stem (everything after the last `/`, with `.md` stripped).
    let stem = path.rsplit('/').next().unwrap_or(path);
    stem.strip_suffix(".md").unwrap_or(stem).to_string()
}

fn collect_tags(_doc: &Document, source: &str, body_tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(fm) = parse_frontmatter(source) {
        for t in fm.get_string_list("tags") {
            out.push(t.to_lowercase());
        }
    }
    // Body-only tags come from the parsed AST's `Inline::Tag` nodes (the
    // walker already collected them). Frontmatter is excluded by
    // construction — `parse()` strips it before block parsing — so a YAML
    // scalar like `summary: "track #urgent"` never reaches the body walk.
    for path in body_tags {
        out.push(path.to_lowercase());
    }
    out.sort();
    out.dedup();
    out
}

fn flatten_frontmatter(source: &str) -> String {
    let Some(fm) = parse_frontmatter(source) else {
        return String::new();
    };
    let mut buf = String::new();
    for (key, value) in fm.flattened_scalars() {
        if key == "title" || key == "tags" || key.starts_with("tags.") {
            continue;
        }
        if !buf.is_empty() {
            buf.push(' ');
        }
        buf.push_str(&key);
        buf.push(' ');
        buf.push_str(&value);
    }
    buf
}

/// Single-pass walker that projects a `Document`'s blocks into the
/// `headings`, `body`, and `code` field strings while also recording
/// body-scoped tags for `collect_tags`.
///
/// Spec rules ([`docs/architecture/document-model.md`] §5; the L4-A plan
/// task 5):
/// - `headings` collects ATX heading text only; we never descend into
///   headings for body text.
/// - `body` accumulates prose / list item / blockquote / table-cell text,
///   standard markdown image alt, and wiki-link display text (alias if
///   set, else the target's last `/`-segment for block-refs).
/// - `body` excludes fenced/inline code, wiki-image embeds
///   (`![[image.png]]`), raw `[[…]]` syntax, raw `#tag` tokens, raw
///   `^block-id` markers, frontmatter, HTML, transcluded content.
/// - `code` collects fenced + inline code text.
#[derive(Default)]
struct Walker {
    headings: String,
    body: String,
    code: String,
    tags: Vec<String>,
}

const IMAGE_EXTS: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

fn target_last_component(target: &str) -> &str {
    target.rsplit('/').next().unwrap_or(target)
}

fn is_image_target(target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(ext))
}

/// Strip standalone `^block-id` tokens from text. A block id is `^`
/// followed by a non-empty run of letters/digits/`_`/`-`, bounded on
/// the left by whitespace or string start and on the right by
/// whitespace or string end. We replace each occurrence with a single
/// space — the body field is whitespace-collapsed at use time, so this
/// keeps surrounding prose intact (`"a ^id b"` → `"a   b"`).
///
/// The defining-line rule in `cubical-core::vault::pending` only treats
/// the last token of a line as a block id, but by the time text reaches
/// the AST inline soft breaks have folded into spaces — we no longer
/// know where the line break was. The body field is text only, never
/// rendered structurally, so a slightly broader strip is acceptable;
/// `^foo` in body prose would just remove `^foo` from the searchable
/// index, which is the correct outcome anyway.
fn strip_block_id_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_was_boundary = true;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' && prev_was_boundary {
            // Collect the candidate block-id body (alphanumeric / `_` / `-`).
            let mut body = String::new();
            while let Some(&p) = chars.peek() {
                if p.is_alphanumeric() || p == '_' || p == '-' {
                    body.push(p);
                    chars.next();
                } else {
                    break;
                }
            }
            let next_is_boundary = chars.peek().map(|c| c.is_whitespace()).unwrap_or(true);
            if !body.is_empty() && next_is_boundary {
                // Replace `^id` with a single space to keep word
                // boundaries with surrounding prose intact.
                out.push(' ');
                prev_was_boundary = true;
                continue;
            }
            // Not a block-id marker — re-emit the consumed run.
            out.push('^');
            out.push_str(&body);
            prev_was_boundary = body
                .chars()
                .last()
                .map(|c| c.is_whitespace())
                .unwrap_or(false);
            continue;
        }
        prev_was_boundary = c.is_whitespace();
        out.push(c);
    }
    out
}

impl Walker {
    fn walk_blocks(&mut self, blocks: &[Block]) {
        for block in blocks {
            self.walk_block(block);
        }
    }

    fn walk_block(&mut self, block: &Block) {
        match block {
            Block::Heading { inlines, .. } => {
                // Collect heading text directly into `headings`; never
                // contribute to `body` or descend with tag collection.
                let mut sink = String::new();
                Self::collect_inline_text(inlines, &mut sink);
                let trimmed = sink.trim();
                if !trimmed.is_empty() {
                    if !self.headings.is_empty() {
                        self.headings.push('\n');
                    }
                    self.headings.push_str(trimmed);
                }
            }
            Block::Paragraph { inlines, .. } => {
                self.walk_inlines(inlines);
            }
            Block::List { items, .. } => {
                for item in items {
                    self.walk_blocks(&item.blocks);
                }
            }
            Block::Quote { blocks, .. } => {
                self.walk_blocks(blocks);
            }
            Block::CodeBlock { content, .. } => {
                self.code.push_str(content);
                if !content.ends_with('\n') {
                    self.code.push('\n');
                }
            }
            Block::ThematicBreak { .. } | Block::Html { .. } => {
                // HTML blocks are excluded from `body` per spec (HTML
                // comments and transclusions don't contribute).
            }
        }
    }

    fn walk_inlines(&mut self, inlines: &[Inline]) {
        for inline in inlines {
            self.walk_inline(inline);
        }
    }

    fn walk_inline(&mut self, inline: &Inline) {
        match inline {
            Inline::Text { value } => {
                self.body.push_str(&strip_block_id_markers(value));
                self.body.push(' ');
            }
            Inline::Emph { children } | Inline::Strong { children } => {
                self.walk_inlines(children);
            }
            Inline::Code { value } => {
                self.code.push_str(value);
                self.code.push('\n');
            }
            Inline::Link { children, .. } => {
                self.walk_inlines(children);
            }
            Inline::Image { alt, .. } => {
                Self::collect_inline_text(alt, &mut self.body);
                self.body.push(' ');
            }
            Inline::LineBreak => {
                self.body.push(' ');
            }
            Inline::WikiLink {
                target,
                display,
                embed,
                ..
            } => {
                // Wiki-image embeds (`![[diagram.png]]`) contribute
                // nothing to `body` — the image asset isn't searchable
                // text.
                if *embed && is_image_target(target) {
                    return;
                }
                let text = match display {
                    Some(d) => d.as_str(),
                    None => target_last_component(target),
                };
                if !text.is_empty() {
                    self.body.push_str(text);
                    self.body.push(' ');
                }
            }
            Inline::Tag { path } => {
                // Body-only tag — recorded for `collect_tags`, never
                // appears in the `body` field.
                self.tags.push(path.clone());
            }
        }
    }

    /// Flatten a chain of inlines into a single text run. Used for
    /// heading text and image alt where we want the textual content
    /// without contributing to `body` mid-walk.
    fn collect_inline_text(inlines: &[Inline], out: &mut String) {
        for inline in inlines {
            match inline {
                Inline::Text { value } => out.push_str(&strip_block_id_markers(value)),
                Inline::Emph { children }
                | Inline::Strong { children }
                | Inline::Link { children, .. } => {
                    Self::collect_inline_text(children, out);
                }
                Inline::Code { value } => out.push_str(value),
                Inline::Image { alt, .. } => Self::collect_inline_text(alt, out),
                Inline::LineBreak => out.push(' '),
                Inline::WikiLink {
                    target,
                    display,
                    embed,
                    ..
                } => {
                    if *embed && is_image_target(target) {
                        continue;
                    }
                    let text = match display {
                        Some(d) => d.as_str(),
                        None => target_last_component(target),
                    };
                    out.push_str(text);
                }
                Inline::Tag { .. } => {}
            }
        }
    }

    fn finish_headings(&mut self) -> String {
        std::mem::take(&mut self.headings)
    }

    fn finish_body(&mut self) -> String {
        std::mem::take(&mut self.body).trim_end().to_string()
    }

    fn finish_code(&mut self) -> String {
        std::mem::take(&mut self.code).trim_end().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_uses_frontmatter_when_present() {
        let src = "---\ntitle: My Note\n---\n\n# Heading\n";
        let d = project("notes/x.md", src, 0, 0);
        assert_eq!(d.title, "My Note");
    }

    #[test]
    fn title_falls_back_to_filename_stem() {
        let src = "Just prose, no frontmatter.\n";
        let d = project("Daily/2026-06-02.md", src, 0, 0);
        assert_eq!(d.title, "2026-06-02");
    }

    #[test]
    fn tags_collected_lowercased_deduped_sorted() {
        let src = "---\ntags: [Project/Cubical, Notes]\n---\n\n#project/cubical and #Notes again\n";
        let d = project("x.md", src, 0, 0);
        assert_eq!(
            d.tags,
            vec!["notes".to_string(), "project/cubical".to_string()]
        );
    }

    #[test]
    fn frontmatter_excludes_title_and_tags() {
        let src = "---\ntitle: T\ntags: [a]\nauthor: jane\n---\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.frontmatter.contains("author"));
        assert!(d.frontmatter.contains("jane"));
        assert!(!d.frontmatter.contains(" T"));
        assert!(!d.frontmatter.contains(" a"));
    }

    #[test]
    fn mtime_and_size_pass_through() {
        let d = project("x.md", "", 1717286400, 42);
        assert_eq!(d.mtime_secs, 1717286400);
        assert_eq!(d.size_bytes, 42);
    }

    #[test]
    fn headings_collected_across_levels() {
        let src = "# H1 alpha\n\n## H2 beta\n\nbody\n\n### H3 gamma\n";
        let d = project("x.md", src, 0, 0);
        assert_eq!(d.headings, "H1 alpha\nH2 beta\nH3 gamma");
    }

    #[test]
    fn body_excludes_code_blocks_and_inline_code() {
        let src = "Prose one.\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n\nProse two with `inline_code` here.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("Prose one"));
        assert!(d.body.contains("Prose two with"));
        assert!(d.body.contains("here"));
        assert!(!d.body.contains("println"));
        assert!(!d.body.contains("inline_code"));
        assert!(d.code.contains("println"));
        assert!(d.code.contains("inline_code"));
    }

    #[test]
    fn body_uses_wikilink_display_text_alias() {
        let src = "See [[Some/Note|the doc]] for context.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("the doc"));
        assert!(!d.body.contains("[["));
        assert!(!d.body.contains("Some/Note"));
    }

    #[test]
    fn body_uses_target_last_component_when_no_alias() {
        let src = "Refer to [[notes/Sub/Topic]] later.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("Topic"));
        assert!(!d.body.contains("notes/Sub"));
    }

    #[test]
    fn body_block_ref_uses_target_not_resolved_content() {
        // ^abc is the block id; the body field must not try to resolve it.
        let src = "Cite [[Other#^abc]] here.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("Other"));
        assert!(!d.body.contains("^abc"));
        assert!(!d.body.contains("abc"));
    }

    #[test]
    fn body_excludes_wiki_image_embeds() {
        let src = "Below: ![[diagram.png]] and prose after.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("Below"));
        assert!(d.body.contains("prose after"));
        assert!(!d.body.contains("diagram.png"));
        assert!(!d.body.contains("![["));
    }

    #[test]
    fn body_includes_standard_image_alt_text() {
        let src = "Look: ![my diagram](./img.png) — and more.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("my diagram"));
    }

    #[test]
    fn body_excludes_raw_tags_and_block_ids() {
        let src = "Some text #project/foo and a marker ^abc123\nplus more.\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.body.contains("Some text"));
        assert!(d.body.contains("plus more"));
        assert!(!d.body.contains("#project"));
        assert!(!d.body.contains("project/foo"));
        assert!(!d.body.contains("^abc123"));
    }
}
