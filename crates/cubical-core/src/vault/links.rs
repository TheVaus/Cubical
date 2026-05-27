//! Extract wiki-link occurrences from a parsed `cubical_ast::Document`
//! and refresh the libSQL `links` index for a single file.
//!
//! [`extract_links`] is the pure walker — `Document` in, `Vec<LinkExtraction>`
//! out, no I/O. [`resolve_target`] is the pure resolver — wiki-link
//! target string + known file list in, vault-relative path out (or `None`).
//! [`refresh_links`] is the side-effecting helper that the scan + watcher
//! write paths call after they UPSERT the matching `files` row — it parses
//! the markdown off the runtime, runs `extract_links`, resolves each
//! occurrence against the live `files.path` set, and atomically replaces
//! the file's rows in the `links` table. The shape and resilience policy
//! mirror `refresh_frontmatter` (delete-then-insert, errors logged at the
//! caller).

use std::path::Path;

use cubical_ast::{parse, Anchor, Block, Document, Inline, ListItem};
use cubical_index::{replace_links_for_file, LinkRow};

use crate::vault::Vault;

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
            Inline::Text { .. } | Inline::Code { .. } | Inline::LineBreak | Inline::Tag { .. } => {}
        }
    }
}

/// Resolve a wiki-link `target_raw` against the known vault file list.
///
/// Resolution order:
/// 1. Exact vault-relative path match (with or without `.md`).
/// 2. Unique basename match, case-insensitive (basename = last path
///    segment, with or without the `.md` suffix).
/// 3. Unique path-suffix match (case-insensitive `ends_with`).
///
/// Returns `None` for no match or for ambiguous matches at levels 2/3.
/// The file list is borrowed; the caller owns it (typically a snapshot
/// from the `files` table).
pub fn resolve_target(target_raw: &str, files: &[String]) -> Option<String> {
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    // 1) exact (with or without .md)
    for f in files {
        if f == target {
            return Some(f.clone());
        }
        if let Some(stem) = f.strip_suffix(".md") {
            if stem == target {
                return Some(f.clone());
            }
        }
    }
    let target_lower = target.to_lowercase();
    // 2) unique basename match, case-insensitive
    let mut basename_matches: Vec<&String> = files
        .iter()
        .filter(|f| {
            let base = f.rsplit('/').next().unwrap_or(f);
            let base_no_ext = base.strip_suffix(".md").unwrap_or(base);
            base_no_ext.to_lowercase() == target_lower || base.to_lowercase() == target_lower
        })
        .collect();
    if basename_matches.len() == 1 {
        return Some(basename_matches.remove(0).clone());
    } else if basename_matches.len() > 1 {
        return None;
    }
    // 3) unique path-suffix match, case-insensitive
    let mut suffix_matches: Vec<&String> = files
        .iter()
        .filter(|f| f.to_lowercase().ends_with(&target_lower))
        .collect();
    if suffix_matches.len() == 1 {
        return Some(suffix_matches.remove(0).clone());
    }
    None
}

/// Parse `abs_path`'s markdown, extract wiki-links, resolve each one
/// against the current `files.path` snapshot, and replace this file's
/// rows in the `links` table.
///
/// `rel_path_str` is the path key used in `files.path` and
/// `links.source_path`. The caller is responsible for ensuring the
/// matching `files` row exists before this is invoked so the FK has a
/// parent to point at.
///
/// On read or parse failure, the file's link rows are wiped (treated
/// as "no wiki-links") rather than left stale. SQL errors propagate so
/// the caller can decide whether to retry; the scan + watcher write
/// paths log and continue, mirroring `refresh_frontmatter`.
pub async fn refresh_links(
    vault: &Vault,
    abs_path: &Path,
    rel_path_str: &str,
) -> Result<u32, libsql::Error> {
    let extractions = match parse_off_executor(abs_path).await {
        Some(doc) => extract_links(&doc),
        None => Vec::new(),
    };

    let files = list_known_paths(vault).await?;
    let rows: Vec<LinkRow> = extractions
        .into_iter()
        .map(|e| {
            let target_path = resolve_target(&e.target_raw, &files);
            let (anchor_kind, anchor_value) = match e.anchor {
                Some(Anchor::Heading { value }) => (Some("heading".to_string()), Some(value)),
                Some(Anchor::Block { value }) => (Some("block".to_string()), Some(value)),
                None => (None, None),
            };
            LinkRow {
                target_raw: e.target_raw,
                target_path,
                anchor_kind,
                anchor_value,
                display_text: e.display,
                is_embed: e.is_embed,
                position: e.position,
            }
        })
        .collect();

    let inserted = rows.len() as u32;
    replace_links_for_file(vault.index(), rel_path_str, &rows)
        .await
        .map_err(map_index_err)?;
    Ok(inserted)
}

/// Snapshot the current `files.path` column. The list is sorted so
/// resolution behaviour is deterministic regardless of insertion order.
async fn list_known_paths(vault: &Vault) -> Result<Vec<String>, libsql::Error> {
    let mut rows = vault
        .index()
        .connection()
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let s: String = row.get(0)?;
        out.push(s);
    }
    Ok(out)
}

/// Read + parse the file off the runtime. Returns `None` if the file
/// can't be read — every failure is logged at `debug` / `warn` and
/// treated as "no wiki-links to record" (the existing rows are wiped
/// by [`refresh_links`]). Mirrors the policy in
/// `vault::frontmatter::parse_off_executor`.
async fn parse_off_executor(abs_path: &Path) -> Option<Document> {
    let path_buf = abs_path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let bytes = match std::fs::read(&path_buf) {
            Ok(b) => b,
            Err(e) => {
                tracing::debug!(path = %path_buf.display(), error = %e, "links: read failed");
                return None;
            }
        };
        let source = String::from_utf8_lossy(&bytes).into_owned();
        Some(parse(&source))
    })
    .await;
    match result {
        Ok(doc) => doc,
        Err(join_err) => {
            tracing::warn!(path = %abs_path.display(), error = %join_err, "links: parse task join failed");
            None
        }
    }
}

/// Translate a `cubical_index::IndexError` into a `libsql::Error` so the
/// scan + watcher write paths can keep treating index failures the same
/// way they treat any other libSQL error.
fn map_index_err(e: cubical_index::IndexError) -> libsql::Error {
    match e {
        cubical_index::IndexError::LibSql(inner) => inner,
        // Other variants don't surface on the link-refresh hot path
        // (no SchemaTooNew once the runner has finished, no I/O error
        // — the connection is already open). Fall through to a libSQL
        // misuse error to keep the signature uniform.
        other => libsql::Error::Misuse(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
