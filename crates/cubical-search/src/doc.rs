//! Project an on-disk markdown file into Tantivy fields.

use cubical_ast::{
    frontmatter::parse_frontmatter,
    parse,
    tag::{scan_tags, TokenizedRun},
    Document,
};

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
/// occurrences (via `cubical_ast::tag::scan_tags`). They are lowercased
/// at projection time so the `tag:` field-prefix query parses to the
/// same form as the indexed value.
#[must_use]
pub fn project(path: &str, source: &str, mtime_secs: i64, size_bytes: u64) -> IndexDoc {
    let doc = parse(source);
    let title = derive_title(path, &doc, source);
    let tags = collect_tags(&doc, source);
    let frontmatter = flatten_frontmatter(source);
    let headings = collect_headings(&doc);
    // body + code are filled by Task 5's walker; placeholders here.
    IndexDoc {
        path: path.to_string(),
        title,
        headings,
        body: String::new(),
        code: String::new(),
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

fn collect_tags(_doc: &Document, source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(fm) = parse_frontmatter(source) {
        for t in fm.get_string_list("tags") {
            out.push(t.to_lowercase());
        }
    }
    for run in scan_tags(source) {
        if let TokenizedRun::Tag { path } = run {
            out.push(path.to_lowercase());
        }
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

fn collect_headings(_doc: &Document) -> String {
    // Filled in Task 5 (heading collection is part of the walker).
    String::new()
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
}
