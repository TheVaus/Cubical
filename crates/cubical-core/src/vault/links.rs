use std::collections::HashMap;
use std::path::Path;

use cubical_ast::{
    basename, scan_wikilinks, strip_markdown_extension, Anchor, Block, Document, Inline, ListItem,
    TokenizedRun,
};
use cubical_index::{replace_links_for_file, LinkRow};

use crate::vault::parse::parse_off_executor;
use crate::vault::Vault;
use cubical_index::fold_name;

#[derive(Debug, Clone, PartialEq)]
pub struct LinkExtraction {
    pub target_raw: String,
    pub anchor: Option<Anchor>,
    pub display: Option<String>,
    pub is_embed: bool,
    pub from_property_ref: bool,
    pub position: u64,
}

pub fn extract_links(doc: &Document) -> Vec<LinkExtraction> {
    let mut out = Vec::new();
    if let Some(frontmatter) = doc.frontmatter.as_ref() {
        let mut ordinal = frontmatter.span.start as u64;
        for (_key, value) in &frontmatter.entries {
            walk_frontmatter_value(value, &mut ordinal, &mut out);
        }
    }
    for block in &doc.blocks {
        walk_block(block, &mut out);
    }
    out
}

fn walk_frontmatter_value(
    value: &serde_json::Value,
    ordinal: &mut u64,
    out: &mut Vec<LinkExtraction>,
) {
    let text = match value {
        serde_json::Value::String(text) => text,
        serde_json::Value::Array(items) => {
            for item in items {
                walk_frontmatter_value(item, ordinal, out);
            }
            return;
        }
        serde_json::Value::Object(entries) => {
            for nested in entries.values() {
                walk_frontmatter_value(nested, ordinal, out);
            }
            return;
        }
        _ => return,
    };
    for run in scan_wikilinks(text) {
        let TokenizedRun::WikiLink {
            target,
            display,
            anchor,
            embed,
        } = run
        else {
            continue;
        };
        out.push(LinkExtraction {
            target_raw: target,
            anchor,
            display,
            is_embed: embed,
            from_property_ref: false,
            position: *ordinal,
        });
        *ordinal += 1;
    }
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
                    from_property_ref: false,
                    position: pos,
                });
            }
            Inline::PropertyRef {
                note: Some(note),
                property,
            } => {
                out.push(LinkExtraction {
                    target_raw: format!("{note}.{property}"),
                    anchor: None,
                    display: None,
                    is_embed: false,
                    from_property_ref: true,
                    position: pos,
                });
            }
            Inline::Emph { children } | Inline::Strong { children } => {
                walk_inlines(children, pos, out);
            }
            Inline::Link { children, .. } => walk_inlines(children, pos, out),
            Inline::Image { alt, .. } => walk_inlines(alt, pos, out),
            Inline::Text { .. }
            | Inline::Code { .. }
            | Inline::LineBreak
            | Inline::Tag { .. }
            | Inline::PropertyRef { note: None, .. } => {}
        }
    }
}

#[must_use]
pub fn keeps_link_row(from_property_ref: bool, target_path: &Option<String>) -> bool {
    !(from_property_ref && target_path.is_none())
}

pub fn resolve_target(target_raw: &str, files: &[String]) -> Option<String> {
    PathResolver::build(files.to_vec()).resolve(target_raw)
}

pub async fn refresh_links(
    vault: &Vault,
    rel_path_str: &str,
    source: &str,
) -> Result<u32, libsql::Error> {
    let extractions = match parse_off_executor(source).await {
        Some(doc) => extract_links(&doc),
        None => Vec::new(),
    };
    write_rows(vault, rel_path_str, extractions).await
}

pub async fn refresh_links_with_doc(
    vault: &Vault,
    rel_path_str: &str,
    doc: &Document,
) -> Result<u32, libsql::Error> {
    write_rows(vault, rel_path_str, extract_links(doc)).await
}

async fn write_rows(
    vault: &Vault,
    rel_path_str: &str,
    extractions: Vec<LinkExtraction>,
) -> Result<u32, libsql::Error> {
    let files = cubical_index::all_file_paths(vault.index())
        .await
        .map_err(map_index_err)?;
    let rows: Vec<LinkRow> = extractions
        .into_iter()
        .filter_map(|e| {
            let target_path = resolve_target(&e.target_raw, &files);
            if !keeps_link_row(e.from_property_ref, &target_path) {
                return None;
            }
            let (anchor_kind, anchor_value) = match e.anchor {
                Some(Anchor::Heading { value }) => (Some("heading".to_string()), Some(value)),
                Some(Anchor::Block { value }) => (Some("block".to_string()), Some(value)),
                None => (None, None),
            };
            Some(LinkRow {
                target_raw: e.target_raw,
                target_path,
                anchor_kind,
                anchor_value,
                display_text: e.display,
                is_embed: e.is_embed,
                position: e.position,
            })
        })
        .collect();

    let inserted = rows.len() as u32;
    replace_links_for_file(vault.index(), rel_path_str, &rows)
        .await
        .map_err(map_index_err)?;
    Ok(inserted)
}

pub async fn read_source_off_executor(abs_path: &Path) -> Option<String> {
    let path_buf = abs_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::fs::read(&path_buf)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    })
    .await
    .ok()
    .flatten()
}

pub(crate) fn map_index_err(e: cubical_index::IndexError) -> libsql::Error {
    match e {
        cubical_index::IndexError::LibSql(inner) => inner,
        other => libsql::Error::Misuse(other.to_string()),
    }
}

pub struct PathResolver {
    all: Vec<String>,
    by_basename: HashMap<String, Vec<usize>>,
    exact: HashMap<String, usize>,
    exact_stem: HashMap<String, usize>,
}

impl PathResolver {
    #[must_use]
    pub fn build(paths: Vec<String>) -> Self {
        let mut by_basename: HashMap<String, Vec<usize>> = HashMap::new();
        let mut exact: HashMap<String, usize> = HashMap::new();
        let mut exact_stem: HashMap<String, usize> = HashMap::new();
        for (i, f) in paths.iter().enumerate() {
            exact.insert(f.clone(), i);
            let stem = strip_markdown_extension(f);
            if stem != f.as_str() {
                exact_stem.insert(stem.to_string(), i);
            }
            let base = basename(f);
            let base_no_ext = strip_markdown_extension(base);
            by_basename
                .entry(fold_name(base_no_ext))
                .or_default()
                .push(i);
            if base != base_no_ext {
                by_basename.entry(fold_name(base)).or_default().push(i);
            }
        }
        for v in by_basename.values_mut() {
            v.sort_unstable();
            v.dedup();
        }
        Self {
            all: paths,
            by_basename,
            exact,
            exact_stem,
        }
    }

    #[must_use]
    pub fn resolve(&self, target_raw: &str) -> Option<String> {
        if target_raw.is_empty() {
            return None;
        }
        if let Some(&i) = self.exact.get(target_raw) {
            return Some(self.all[i].clone());
        }
        if let Some(&i) = self.exact_stem.get(target_raw) {
            return Some(self.all[i].clone());
        }
        let target_lower = fold_name(target_raw);
        if let Some(idxs) = self.by_basename.get(&target_lower) {
            if idxs.len() == 1 {
                return Some(self.all[idxs[0]].clone());
            } else if idxs.len() > 1 {
                return None;
            }
        }
        let mut suffix_matches = self.all.iter().filter(|f| {
            let fl = fold_name(f);
            if !fl.ends_with(&target_lower) {
                return false;
            }
            let prefix_len = fl.len() - target_lower.len();
            prefix_len == 0 || fl.as_bytes()[prefix_len - 1] == b'/'
        });
        let first = suffix_matches.next();
        match (first, suffix_matches.next()) {
            (Some(f), None) => Some(f.clone()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_ast::parse;

    #[test]
    fn path_resolver_matches_resolve_target_semantics() {
        let files = vec![
            "a.md".to_string(),
            "notes/b.md".to_string(),
            "notes/sub/c.md".to_string(),
            "Dup.md".to_string(),
            "other/Dup.md".to_string(),
        ];
        let r = PathResolver::build(files.clone());
        for target in [
            "a", "a.md", "b", "notes/b", "c", "sub/c.md", "Dup", "dup", "missing", "", "  ", "B",
            "NOTES/B",
        ] {
            assert_eq!(
                r.resolve(target),
                resolve_target(target, &files),
                "mismatch for target {target:?}"
            );
        }
    }

    #[test]
    fn path_resolver_resolves_exact_and_basename_in_constant_lookups() {
        let files: Vec<String> = (0..1000).map(|i| format!("dir/n{i:04}.md")).collect();
        let r = PathResolver::build(files);
        assert_eq!(r.resolve("n0500"), Some("dir/n0500.md".to_string()));
        assert_eq!(r.resolve("dir/n0999.md"), Some("dir/n0999.md".to_string()));
        assert_eq!(r.resolve("nope"), None);
    }

    #[test]
    fn extract_links_returns_occurrences_without_db() {
        let got = extract_links(&parse("see [[b]] and [[c|display]] plus ![[d]]\n"));
        let targets: Vec<&str> = got.iter().map(|e| e.target_raw.as_str()).collect();
        assert_eq!(targets, vec!["b", "c", "d"]);
        assert!(got.iter().any(|e| e.is_embed));
    }

    #[test]
    fn extract_links_empty_input_returns_empty() {
        assert!(extract_links(&parse("")).is_empty());
    }

    #[test]
    fn extracts_simple_wikilink() {
        let doc = parse("see [[note]] for context\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "note");
        assert!(links[0].anchor.is_none());
        assert!(!links[0].is_embed);
        assert!(!links[0].from_property_ref);
    }

    #[test]
    fn extracts_wikilink_from_a_quoted_frontmatter_string() {
        let doc = parse("---\nhome: \"[[Rivendell]]\"\n---\nbody\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Rivendell");
        assert!(!links[0].is_embed);
        assert!(!links[0].from_property_ref);
    }

    #[test]
    fn extracts_wikilinks_from_a_frontmatter_list() {
        let doc = parse("---\noffsprings:\n  - \"[[Jack]]\"\n  - \"[[Jill]]\"\n---\nbody\n");
        let targets: Vec<String> = extract_links(&doc)
            .into_iter()
            .map(|e| e.target_raw)
            .collect();
        assert_eq!(targets, vec!["Jack".to_string(), "Jill".to_string()]);
    }

    #[test]
    fn extracts_wikilink_from_a_nested_frontmatter_map() {
        let doc = parse("---\nmeta:\n  home: \"[[Rivendell]]\"\n---\nbody\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Rivendell");
    }

    #[test]
    fn unquoted_frontmatter_brackets_are_a_yaml_list_and_not_a_link() {
        let doc = parse("---\nhome: [[Rivendell]]\n---\nbody\n");
        assert!(extract_links(&doc).is_empty());
    }

    #[test]
    fn frontmatter_and_body_links_are_both_extracted() {
        let doc = parse("---\nhome: \"[[Rivendell]]\"\n---\nsee [[Moria]]\n");
        let targets: Vec<String> = extract_links(&doc)
            .into_iter()
            .map(|e| e.target_raw)
            .collect();
        assert_eq!(targets, vec!["Rivendell".to_string(), "Moria".to_string()]);
    }

    #[test]
    fn a_frontmatter_link_carries_display_and_anchor() {
        let doc = parse("---\nhome: \"[[Rivendell#Hall|Last Homely House]]\"\n---\nbody\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Rivendell");
        assert_eq!(links[0].display.as_deref(), Some("Last Homely House"));
        assert!(links[0].anchor.is_some());
    }

    #[test]
    fn frontmatter_links_get_distinct_positions() {
        let doc = parse("---\noffsprings:\n  - \"[[Jack]]\"\n  - \"[[Jill]]\"\n---\nbody\n");
        let positions: Vec<u64> = extract_links(&doc).iter().map(|e| e.position).collect();
        assert_eq!(positions.len(), 2);
        assert_ne!(
            positions[0], positions[1],
            "backlink rows are keyed by source_path@position in the UI"
        );
    }

    #[test]
    fn frontmatter_link_positions_stay_inside_the_frontmatter_block() {
        let source = "---\nhome: \"[[Rivendell]]\"\nalt: \"[[Moria]]\"\n---\nsee [[Shire]]\n";
        let doc = parse(source);
        let body_offset = doc.frontmatter.as_ref().expect("frontmatter").span.end as u64;
        let links = extract_links(&doc);
        let (fm, body): (Vec<_>, Vec<_>) = links.iter().partition(|e| e.target_raw != "Shire");
        assert!(fm.iter().all(|e| e.position < body_offset));
        assert!(body.iter().all(|e| e.position >= body_offset));
    }

    #[test]
    fn extracts_cross_file_property_ref_as_link_candidate() {
        let doc = parse("see [[Report v1.2]] here\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Report v1.2");
        assert!(links[0].from_property_ref);
    }

    #[test]
    fn self_property_ref_is_not_a_link_candidate() {
        let doc = parse("value [[.age]] here\n");
        assert!(extract_links(&doc).is_empty());
    }

    #[test]
    fn keeps_link_row_drops_only_unresolved_property_refs() {
        assert!(keeps_link_row(true, &Some("Report v1.2.md".to_string())));
        assert!(!keeps_link_row(true, &None));
        assert!(keeps_link_row(false, &None));
        assert!(keeps_link_row(false, &Some("a.md".to_string())));
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

    #[test]
    fn resolve_exact_match() {
        let files = vec!["notes/Other Note.md".to_string()];
        assert_eq!(
            resolve_target("notes/Other Note.md", &files).as_deref(),
            Some("notes/Other Note.md"),
        );
    }

    #[test]
    fn resolve_exact_without_extension() {
        let files = vec!["notes/Other Note.md".to_string()];
        assert_eq!(
            resolve_target("notes/Other Note", &files).as_deref(),
            Some("notes/Other Note.md"),
        );
    }

    #[test]
    fn resolve_basename_case_insensitive() {
        let files = vec!["notes/other-note.md".to_string()];
        assert_eq!(
            resolve_target("Other-Note", &files).as_deref(),
            Some("notes/other-note.md"),
        );
    }

    #[test]
    fn resolve_unique_suffix() {
        let files = vec![
            "deeply/nested/path/foo.md".to_string(),
            "bar.md".to_string(),
        ];
        assert_eq!(
            resolve_target("path/foo.md", &files).as_deref(),
            Some("deeply/nested/path/foo.md"),
        );
    }

    #[test]
    fn resolve_suffix_requires_path_boundary() {
        let files = vec!["grab.md".to_string()];
        assert!(
            resolve_target("b.md", &files).is_none(),
            "suffix match must not fire mid-segment (grab.md is not a match for b.md)",
        );
        let files2 = vec!["deeply/nested/foo.md".to_string()];
        assert_eq!(
            resolve_target("nested/foo.md", &files2).as_deref(),
            Some("deeply/nested/foo.md"),
        );
    }

    #[test]
    fn resolve_ambiguous_returns_none() {
        let files = vec!["a/note.md".to_string(), "b/note.md".to_string()];
        assert!(
            resolve_target("note", &files).is_none(),
            "ambiguous basename match must not resolve"
        );
    }

    #[test]
    fn resolve_missing_returns_none() {
        let files = vec!["a.md".to_string()];
        assert!(resolve_target("nope", &files).is_none());
    }

    #[test]
    fn resolve_empty_target_is_none() {
        let files = vec!["a.md".to_string()];
        assert!(resolve_target("", &files).is_none());
        assert!(resolve_target("   ", &files).is_none());
    }
}
