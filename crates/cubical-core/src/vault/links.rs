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

use std::collections::HashMap;
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

/// Resolve a wiki-link target against a snapshot of `files.path`.
///
/// Thin wrapper over [`PathResolver`] kept for the single-file watcher
/// path (one edit → one build → resolve this file's links). The bulk
/// scan builds a `PathResolver` once and calls `.resolve()` directly.
///
/// Resolution order:
/// 1. Exact vault-relative path match (with or without `.md`).
/// 2. Unique basename match, case-insensitive (basename = last path
///    segment, with or without the `.md` suffix).
/// 3. Unique path-suffix match (case-insensitive `ends_with`).
///
/// Returns `None` for no match or for ambiguous matches at levels 2/3.
pub fn resolve_target(target_raw: &str, files: &[String]) -> Option<String> {
    PathResolver::build(files.to_vec()).resolve(target_raw)
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

/// Parse `abs_path` off the runtime and return its wiki-link
/// occurrences, **without** resolving them or touching the DB. Used by
/// the bulk scan's Pass 1 to buffer extractions for a single post-walk
/// resolution pass (Pass 2). Returns an empty vec when the file can't
/// be read/parsed — mirrors `refresh_links`'s "no links" policy.
pub(crate) async fn extract_links_off_executor(abs_path: &Path) -> Vec<LinkExtraction> {
    match parse_off_executor(abs_path).await {
        Some(doc) => extract_links(&doc),
        None => Vec::new(),
    }
}

/// Read `abs_path`'s raw bytes off the runtime as lossy UTF-8.
/// `None` when the file can't be read. Used by block-id scanning,
/// which needs source text rather than a parsed `Document`.
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

/// Translate a `cubical_index::IndexError` into a `libsql::Error` so the
/// scan + watcher write paths can keep treating index failures the same
/// way they treat any other libSQL error.
pub(crate) fn map_index_err(e: cubical_index::IndexError) -> libsql::Error {
    match e {
        cubical_index::IndexError::LibSql(inner) => inner,
        // Other variants don't surface on the link-refresh hot path
        // (no SchemaTooNew once the runner has finished, no I/O error
        // — the connection is already open). Fall through to a libSQL
        // misuse error to keep the signature uniform.
        other => libsql::Error::Misuse(other.to_string()),
    }
}

/// Index over the vault's `files.path` set for wiki-link resolution.
///
/// Built once per bulk scan (and per single-file watcher edit) rather
/// than re-scanning a `&[String]` for every link. Resolution order is
/// identical to [`resolve_target`]: exact (with/without `.md`) →
/// unique case-insensitive basename → unique case-insensitive suffix.
/// Exact and basename lookups are O(1); the suffix stage is a linear
/// fallback over `all` and only runs when the first two miss (rare —
/// only for targets that don't match a real note).
pub struct PathResolver {
    /// Every path, verbatim — used for the exact stage and the suffix
    /// fallback. Order is irrelevant.
    all: Vec<String>,
    /// Lowercased basename (without `.md`) AND lowercased basename
    /// (with `.md`) → the paths carrying it. A target resolves at this
    /// stage only when exactly one path maps to it.
    by_basename: HashMap<String, Vec<usize>>,
    /// Verbatim path string → index, for the exact-with-extension hit.
    exact: HashMap<String, usize>,
    /// Path-without-`.md` → index, for the exact-without-extension hit.
    exact_stem: HashMap<String, usize>,
}

impl PathResolver {
    /// Build the index from the complete path set. O(N).
    #[must_use]
    pub fn build(paths: Vec<String>) -> Self {
        let mut by_basename: HashMap<String, Vec<usize>> = HashMap::new();
        let mut exact: HashMap<String, usize> = HashMap::new();
        let mut exact_stem: HashMap<String, usize> = HashMap::new();
        for (i, f) in paths.iter().enumerate() {
            exact.insert(f.clone(), i);
            if let Some(stem) = f.strip_suffix(".md") {
                exact_stem.insert(stem.to_string(), i);
            }
            let base = f.rsplit('/').next().unwrap_or(f);
            let base_no_ext = base.strip_suffix(".md").unwrap_or(base);
            by_basename
                .entry(base_no_ext.to_lowercase())
                .or_default()
                .push(i);
            // Also key by the with-extension basename so a target like
            // "b.md" matches at the basename stage, mirroring resolve_target.
            if base != base_no_ext {
                by_basename.entry(base.to_lowercase()).or_default().push(i);
            }
        }
        // De-duplicate index lists so a file keyed under both basename
        // forms is not double-counted when the two forms collide.
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

    /// Resolve a wiki-link target to a vault-relative path, or `None`
    /// when there is no unique match. Semantics identical to
    /// [`resolve_target`].
    #[must_use]
    pub fn resolve(&self, target_raw: &str) -> Option<String> {
        let target = target_raw.trim();
        if target.is_empty() {
            return None;
        }
        // 1) exact (with or without .md)
        if let Some(&i) = self.exact.get(target) {
            return Some(self.all[i].clone());
        }
        if let Some(&i) = self.exact_stem.get(target) {
            return Some(self.all[i].clone());
        }
        // 2) unique basename match, case-insensitive
        let target_lower = target.to_lowercase();
        if let Some(idxs) = self.by_basename.get(&target_lower) {
            if idxs.len() == 1 {
                return Some(self.all[idxs[0]].clone());
            } else if idxs.len() > 1 {
                return None; // ambiguous basename → unresolved
            }
        }
        // 3) unique path-suffix match, case-insensitive (linear fallback)
        let mut suffix_matches = self
            .all
            .iter()
            .filter(|f| f.to_lowercase().ends_with(&target_lower));
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

    #[test]
    fn path_resolver_matches_resolve_target_semantics() {
        let files = vec![
            "a.md".to_string(),
            "notes/b.md".to_string(),
            "notes/sub/c.md".to_string(),
            "Dup.md".to_string(),
            "other/Dup.md".to_string(), // ambiguous basename "dup"
        ];
        let r = PathResolver::build(files.clone());
        // For a battery of targets, PathResolver must agree with resolve_target.
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
        // Build once, resolve many — proves resolution does not re-scan per call.
        let files: Vec<String> = (0..1000).map(|i| format!("dir/n{i:04}.md")).collect();
        let r = PathResolver::build(files);
        assert_eq!(r.resolve("n0500"), Some("dir/n0500.md".to_string()));
        assert_eq!(r.resolve("dir/n0999.md"), Some("dir/n0999.md".to_string()));
        assert_eq!(r.resolve("nope"), None);
    }

    #[tokio::test]
    async fn extract_links_off_executor_returns_occurrences_without_db() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        std::fs::write(&p, "see [[b]] and [[c|display]] plus ![[d]]\n").unwrap();
        let got = extract_links_off_executor(&p).await;
        let targets: Vec<&str> = got.iter().map(|e| e.target_raw.as_str()).collect();
        assert_eq!(targets, vec!["b", "c", "d"]);
        assert!(got.iter().any(|e| e.is_embed)); // ![[d]]
    }

    #[tokio::test]
    async fn extract_links_off_executor_unreadable_file_returns_empty() {
        let got = extract_links_off_executor(std::path::Path::new("/no/such/file.md")).await;
        assert!(got.is_empty());
    }

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
