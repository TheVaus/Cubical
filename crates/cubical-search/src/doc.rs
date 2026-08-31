use cubical_ast::{basename, note_title, parse, Block, Document, Inline};

#[derive(Debug, Clone, PartialEq)]
pub struct IndexDoc {
    pub path: String,
    pub title: String,
    pub headings: String,
    pub body: String,
    pub code: String,
    pub tags: Vec<String>,
    pub frontmatter: String,
    pub mtime_secs: i64,
    pub size_bytes: u64,
}

#[must_use]
pub fn project(path: &str, source: &str, mtime_secs: i64, size_bytes: u64) -> IndexDoc {
    project_with_doc(path, &parse(source), mtime_secs, size_bytes)
}

#[must_use]
pub fn project_with_doc(path: &str, doc: &Document, mtime_secs: i64, size_bytes: u64) -> IndexDoc {
    let title = derive_title(path, doc);
    let mut walker = Walker::default();
    walker.walk_blocks(&doc.blocks);
    let tags = collect_tags(doc, &walker.tags);
    let frontmatter = flatten_frontmatter(doc);
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

fn derive_title(path: &str, doc: &Document) -> String {
    if let Some(fm) = &doc.frontmatter {
        if let Some(t) = fm.get_string("title") {
            return t.to_string();
        }
    }
    note_title(path).to_string()
}

fn collect_tags(doc: &Document, body_tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(fm) = &doc.frontmatter {
        for t in fm.get_string_list("tags") {
            out.push(t.to_lowercase());
        }
    }
    for path in body_tags {
        out.push(path.to_lowercase());
    }
    out.sort();
    out.dedup();
    out
}

fn flatten_frontmatter(doc: &Document) -> String {
    let Some(fm) = &doc.frontmatter else {
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

#[derive(Default)]
struct Walker {
    headings: String,
    body: String,
    code: String,
    tags: Vec<String>,
}

const IMAGE_EXTS: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

fn is_image_target(target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(ext))
}

fn strip_block_id_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_was_boundary = true;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' && prev_was_boundary {
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
                out.push(' ');
                prev_was_boundary = true;
                continue;
            }
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
            Block::ThematicBreak { .. } | Block::Html { .. } => {}
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
                if *embed && is_image_target(target) {
                    return;
                }
                let text = match display {
                    Some(d) => d.as_str(),
                    None => basename(target),
                };
                if !text.is_empty() {
                    self.body.push_str(text);
                    self.body.push(' ');
                }
            }
            Inline::Tag { path } => {
                self.tags.push(path.clone());
            }
            Inline::PropertyRef { .. } => {}
        }
    }

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
                        None => basename(target),
                    };
                    out.push_str(text);
                }
                Inline::Tag { .. } => {}
                Inline::PropertyRef { .. } => {}
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
    fn project_with_doc_matches_project_on_the_same_source() {
        let sources = [
            "",
            "plain prose only\n",
            "---\ntitle: T\ntags: [A, b/c]\nauthor: jane\nn: 3\n---\n\n# H1\n\nbody [[link|alias]] ![[img.png]] #inline/tag\n\n```rs\nfn f() {}\n```\n",
            "---\ntitle: : :\n  - bad\n---\n\nmalformed frontmatter body\n",
            "> quote with #q\n\n- item [[a]]\n- item `code`\n",
        ];
        for src in sources {
            assert_eq!(
                project_with_doc("notes/x.md", &parse(src), 7, 11),
                project("notes/x.md", src, 7, 11),
                "projection diverged for {src:?}"
            );
        }
    }

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
