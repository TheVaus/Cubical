//! Extract tag occurrences from a parsed `cubical_ast::Document` and
//! refresh the libSQL `tags` index for a single file.
//!
//! [`extract_tags`] is the pure walker — `Document` in, `Vec<TagExtraction>`
//! out, no I/O. [`refresh_tags`] is the side-effecting helper that the
//! scan + watcher write paths call after they UPSERT the matching
//! `files` row — it parses the markdown off the runtime, runs
//! `extract_tags`, and atomically replaces the file's rows in the
//! `tags` table. Shape and resilience policy mirror
//! [`crate::vault::links::refresh_links`].
//!
//! Two declaration sources feed one extraction (`docs/layer-3-spec.md`
//! §2.4): inline `#tag` tokens parsed into [`cubical_ast::Inline::Tag`]
//! by the AST normalizer, and frontmatter `tags:` entries pulled from
//! the parsed [`cubical_ast::Frontmatter`]. The `source` field on each
//! extraction discriminates the two so the libSQL row carries the
//! correct `source` column.
//!
//! Within a single file we dedupe by `(lowercase(tag_path), source)`:
//! `#FooBar` and `#foobar` in the same file collapse to one row, with
//! the first-seen casing preserved (matches the spec's "case-insensitive
//! matching, case-preserving display" rule).

use cubical_ast::{parse, Block, Document, Inline, ListItem};
use cubical_index::{replace_tags_for_file, TagRow, TagSource};

use crate::vault::Vault;

/// One tag occurrence extracted from a `Document`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagExtraction {
    /// The tag body without the leading `#`, with the case as written
    /// at the first occurrence within the file. Nested via `/`.
    pub tag_path: String,
    /// Where this occurrence was declared.
    pub source: TagSource,
}

/// Walk a `Document` and return one [`TagExtraction`] per unique
/// `(tag_path lowercase, source)` pair, preserving the first-seen
/// casing of each tag. Order: every inline tag (in document order)
/// followed by every frontmatter tag (in YAML order).
#[must_use]
pub fn extract_tags(doc: &Document) -> Vec<TagExtraction> {
    let mut seen_inline: Vec<(String, String)> = Vec::new(); // (lc, original)
    let mut seen_frontmatter: Vec<(String, String)> = Vec::new();

    for block in &doc.blocks {
        collect_inline_tags(block, &mut seen_inline);
    }
    if let Some(fm) = &doc.frontmatter {
        for (key, value) in &fm.entries {
            if !key.eq_ignore_ascii_case("tags") {
                continue;
            }
            collect_frontmatter_tags(value, &mut seen_frontmatter);
        }
    }

    let mut out = Vec::with_capacity(seen_inline.len().saturating_add(seen_frontmatter.len()));
    for (_, original) in seen_inline {
        out.push(TagExtraction {
            tag_path: original,
            source: TagSource::Inline,
        });
    }
    for (_, original) in seen_frontmatter {
        out.push(TagExtraction {
            tag_path: original,
            source: TagSource::Frontmatter,
        });
    }
    out
}

fn collect_inline_tags(block: &Block, seen: &mut Vec<(String, String)>) {
    match block {
        Block::Heading { inlines, .. } | Block::Paragraph { inlines, .. } => {
            walk_inlines(inlines, seen);
        }
        Block::List { items, .. } => {
            for ListItem { blocks, .. } in items {
                for sub in blocks {
                    collect_inline_tags(sub, seen);
                }
            }
        }
        Block::Quote { blocks, .. } => {
            for sub in blocks {
                collect_inline_tags(sub, seen);
            }
        }
        Block::CodeBlock { .. } | Block::ThematicBreak { .. } | Block::Html { .. } => {}
    }
}

fn walk_inlines(inlines: &[Inline], seen: &mut Vec<(String, String)>) {
    for inline in inlines {
        match inline {
            Inline::Tag { path } => push_unique(seen, path),
            Inline::Emph { children } | Inline::Strong { children } => {
                walk_inlines(children, seen);
            }
            Inline::Link { children, .. } => walk_inlines(children, seen),
            Inline::Image { alt, .. } => walk_inlines(alt, seen),
            Inline::Text { .. }
            | Inline::Code { .. }
            | Inline::LineBreak
            | Inline::WikiLink { .. }
            | Inline::PropertyRef { .. } => {}
        }
    }
}

fn collect_frontmatter_tags(value: &serde_json::Value, seen: &mut Vec<(String, String)>) {
    match value {
        serde_json::Value::String(s) => {
            for tag in parse_frontmatter_tag_string(s) {
                push_unique(seen, &tag);
            }
        }
        serde_json::Value::Array(arr) => {
            for entry in arr {
                collect_frontmatter_tags(entry, seen);
            }
        }
        // Numbers, booleans, nulls, objects: not tag-shaped. Skip.
        _ => {}
    }
}

/// Split a frontmatter `tags:` scalar into individual tag bodies.
///
/// `tags: foo` yields `["foo"]`. `tags: "foo, bar"` and
/// `tags: "foo bar"` both yield `["foo", "bar"]` — common in
/// hand-written Obsidian frontmatter where the user types one string
/// instead of a YAML list. Leading `#` is stripped because the YAML
/// scalar usually omits it but some users include it; either survives.
fn parse_frontmatter_tag_string(raw: &str) -> Vec<String> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix('#').unwrap_or(s).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Insert `(lowercase, original)` into `seen` if the lowercase form
/// isn't already present; do nothing if it is. First-seen casing wins.
fn push_unique(seen: &mut Vec<(String, String)>, candidate: &str) {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return;
    }
    let lc = trimmed.to_ascii_lowercase();
    if seen.iter().any(|(prev_lc, _)| prev_lc == &lc) {
        return;
    }
    seen.push((lc, trimmed.to_string()));
}

/// Parse `abs_path`'s markdown, extract tags (inline + frontmatter), and
/// replace this file's rows in the `tags` table.
///
/// `rel_path_str` is the path key used in `files.path` and
/// `tags.file_path`. The caller is responsible for ensuring the matching
/// `files` row exists before this is invoked so the FK has a parent to
/// point at.
///
/// On read or parse failure, the file's tag rows are wiped (treated as
/// "no tags") rather than left stale. SQL errors propagate so the
/// caller can decide whether to retry; the scan + watcher write paths
/// log and continue, mirroring `refresh_links`.
pub async fn refresh_tags(
    vault: &Vault,
    rel_path_str: &str,
    source: &str,
) -> Result<u32, libsql::Error> {
    let extractions = match parse_off_executor(source).await {
        Some(doc) => extract_tags(&doc),
        None => Vec::new(),
    };

    let rows: Vec<TagRow> = extractions
        .into_iter()
        .map(|e| TagRow {
            tag_path: e.tag_path,
            source: e.source,
        })
        .collect();

    let inserted = rows.len() as u32;
    replace_tags_for_file(vault.index(), rel_path_str, &rows)
        .await
        .map_err(map_index_err)?;
    Ok(inserted)
}

/// Parse `source` off the runtime. Returns `None` only if the parse
/// task itself fails to join — every failure is logged at `warn` and
/// treated as "no tags to record" (the existing rows are wiped by
/// [`refresh_tags`]).
async fn parse_off_executor(source: &str) -> Option<Document> {
    let owned = source.to_string();
    let result = tokio::task::spawn_blocking(move || parse(&owned)).await;
    match result {
        Ok(doc) => Some(doc),
        Err(join_err) => {
            tracing::warn!(error = %join_err, "tags: parse task join failed");
            None
        }
    }
}

fn map_index_err(e: cubical_index::IndexError) -> libsql::Error {
    match e {
        cubical_index::IndexError::LibSql(inner) => inner,
        other => libsql::Error::Misuse(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_single_inline_tag() {
        let doc = parse("see #todo for context\n");
        let tags = extract_tags(&doc);
        assert_eq!(
            tags,
            vec![TagExtraction {
                tag_path: "todo".into(),
                source: TagSource::Inline,
            }]
        );
    }

    #[test]
    fn extracts_nested_inline_tag() {
        let doc = parse("under #project/cubical/l3\n");
        let tags = extract_tags(&doc);
        assert_eq!(
            tags,
            vec![TagExtraction {
                tag_path: "project/cubical/l3".into(),
                source: TagSource::Inline,
            }]
        );
    }

    #[test]
    fn extracts_multiple_inline_tags_in_order() {
        let doc = parse("#a #b #c\n");
        let tags = extract_tags(&doc);
        let paths: Vec<&str> = tags.iter().map(|t| t.tag_path.as_str()).collect();
        assert_eq!(paths, vec!["a", "b", "c"]);
    }

    #[test]
    fn dedupes_inline_tags_by_case_insensitive_path() {
        let doc = parse("#FooBar then later #foobar and #FOOBAR\n");
        let tags = extract_tags(&doc);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].tag_path, "FooBar", "first-seen casing wins");
    }

    #[test]
    fn ignores_tag_inside_code_span() {
        let doc = parse("literal `#notatag` here\n");
        let tags = extract_tags(&doc);
        assert!(tags.is_empty());
    }

    #[test]
    fn ignores_tag_inside_fenced_code_block() {
        let doc = parse("```\n#notatag\n```\n");
        let tags = extract_tags(&doc);
        assert!(tags.is_empty());
    }

    #[test]
    fn ignores_word_following_hash() {
        let doc = parse("issue#42 is fixed\n");
        let tags = extract_tags(&doc);
        assert!(tags.is_empty());
    }

    #[test]
    fn extracts_tags_in_emphasis_and_quotes() {
        let doc = parse("*#emphtag*\n\n> #quotetag\n");
        let tags = extract_tags(&doc);
        let paths: Vec<&str> = tags.iter().map(|t| t.tag_path.as_str()).collect();
        assert_eq!(paths, vec!["emphtag", "quotetag"]);
    }

    #[test]
    fn extracts_tags_from_list_items() {
        let doc = parse("- item with #one\n- another #two\n");
        let tags = extract_tags(&doc);
        let paths: Vec<&str> = tags.iter().map(|t| t.tag_path.as_str()).collect();
        assert_eq!(paths, vec!["one", "two"]);
    }

    #[test]
    fn extracts_frontmatter_tags_from_yaml_sequence() {
        let doc = parse("---\ntags: [foo, bar/baz]\n---\nbody\n");
        let tags = extract_tags(&doc);
        let pairs: Vec<(&str, TagSource)> = tags
            .iter()
            .map(|t| (t.tag_path.as_str(), t.source))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("foo", TagSource::Frontmatter),
                ("bar/baz", TagSource::Frontmatter),
            ]
        );
    }

    #[test]
    fn extracts_frontmatter_tags_from_scalar_string() {
        let doc = parse("---\ntags: \"alpha, beta gamma\"\n---\nbody\n");
        let tags = extract_tags(&doc);
        let paths: Vec<&str> = tags.iter().map(|t| t.tag_path.as_str()).collect();
        // Comma-and-whitespace split; "alpha", "beta", "gamma".
        assert_eq!(paths, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn strips_leading_hash_from_frontmatter_scalar() {
        let doc = parse("---\ntags: [\"#foo\", \"#bar\"]\n---\nbody\n");
        let tags = extract_tags(&doc);
        let paths: Vec<&str> = tags.iter().map(|t| t.tag_path.as_str()).collect();
        assert_eq!(paths, vec!["foo", "bar"]);
    }

    #[test]
    fn combines_frontmatter_and_inline_with_dedup() {
        // Frontmatter has FooBar; inline has foobar. Same logical tag,
        // different sources — both rows ship.
        let doc = parse("---\ntags: [FooBar]\n---\n#foobar in body\n");
        let tags = extract_tags(&doc);
        assert_eq!(tags.len(), 2);
        // Inline first (document order), then frontmatter.
        assert_eq!(tags[0].source, TagSource::Inline);
        assert_eq!(tags[0].tag_path, "foobar");
        assert_eq!(tags[1].source, TagSource::Frontmatter);
        assert_eq!(tags[1].tag_path, "FooBar");
    }

    #[test]
    fn ignores_non_tag_frontmatter_values() {
        let doc = parse("---\ntags: 42\nother: [a, b]\n---\nbody\n");
        let tags = extract_tags(&doc);
        assert!(tags.is_empty(), "numeric tags value contributes nothing");
    }

    #[test]
    fn empty_doc_has_no_tags() {
        let doc = parse("");
        assert!(extract_tags(&doc).is_empty());
    }
}
