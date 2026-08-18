use cubical_ast::{Block, Document, Inline, ListItem};
use cubical_index::{replace_tags_for_file, TagRow, TagSource};

use crate::vault::parse::parse_off_executor;
use crate::vault::Vault;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagExtraction {
    pub tag_path: String,
    pub source: TagSource,
}

#[must_use]
pub fn extract_tags(doc: &Document) -> Vec<TagExtraction> {
    let mut seen_inline: Vec<(String, String)> = Vec::new();
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
        _ => {}
    }
}

fn parse_frontmatter_tag_string(raw: &str) -> Vec<String> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix('#').unwrap_or(s).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

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

pub async fn refresh_tags(
    vault: &Vault,
    rel_path_str: &str,
    source: &str,
) -> Result<u32, libsql::Error> {
    let extractions = match parse_off_executor(source).await {
        Some(doc) => extract_tags(&doc),
        None => Vec::new(),
    };
    write_rows(vault, rel_path_str, extractions).await
}

pub async fn refresh_tags_with_doc(
    vault: &Vault,
    rel_path_str: &str,
    doc: &Document,
) -> Result<u32, libsql::Error> {
    write_rows(vault, rel_path_str, extract_tags(doc)).await
}

async fn write_rows(
    vault: &Vault,
    rel_path_str: &str,
    extractions: Vec<TagExtraction>,
) -> Result<u32, libsql::Error> {
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

fn map_index_err(e: cubical_index::IndexError) -> libsql::Error {
    match e {
        cubical_index::IndexError::LibSql(inner) => inner,
        other => libsql::Error::Misuse(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_ast::parse;

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
        let doc = parse("---\ntags: [FooBar]\n---\n#foobar in body\n");
        let tags = extract_tags(&doc);
        assert_eq!(tags.len(), 2);
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
