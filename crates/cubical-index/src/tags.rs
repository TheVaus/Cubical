//! Queries against the L3 `tags` table.
//!
//! The schema is in `migrations/004_tags.sql`. One row per
//! `(file_path, tag_path, source)` triple — inline `#tag` tokens and
//! frontmatter `tags:` entries feed the same table with a discriminating
//! `source` column. See `docs/layer-3-spec.md` §2.4 and
//! `docs/architecture/document-model.md` §5.6.

use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

/// Where a tag was declared.
///
/// `Inline` covers `#tag` tokens in the markdown body; `Frontmatter`
/// covers entries in the YAML `tags:` list (whether scalar or sequence).
/// Stored as the string `"inline"` / `"frontmatter"` in the `source`
/// column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagSource {
    /// `#tag` token in the markdown body.
    Inline,
    /// `tags:` entry in the YAML frontmatter.
    Frontmatter,
}

impl TagSource {
    /// String form stored in the `source` column.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            TagSource::Inline => "inline",
            TagSource::Frontmatter => "frontmatter",
        }
    }
}

/// One row inserted into the `tags` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRow {
    /// The tag body without the leading `#`, with the case as written.
    pub tag_path: String,
    /// Whether this row was sourced from an inline token or a
    /// frontmatter entry.
    pub source: TagSource,
}

/// Replace the entire set of tag rows for `file_path`.
///
/// "Delete-then-insert" semantics keyed on `file_path`: any prior rows
/// for the file are removed, then `rows` is inserted. `rows` may be
/// empty — the call simply clears the file's tag rows.
///
/// As with [`crate::replace_links_for_file`], the DELETE and INSERTs are
/// not wrapped in their own transaction — they execute directly on the
/// caller's connection so they participate in any outer transaction the
/// caller has open.
pub async fn replace_tags_for_file(
    conn: &IndexConn,
    file_path: &str,
    rows: &[TagRow],
) -> Result<(), IndexError> {
    let c = conn.connection();
    c.execute("DELETE FROM tags WHERE file_path = ?1", params![file_path])
        .await?;
    for r in rows {
        c.execute(
            "INSERT OR IGNORE INTO tags (file_path, tag_path, source) \
             VALUES (?1, ?2, ?3)",
            params![file_path, r.tag_path.clone(), r.source.as_str()],
        )
        .await?;
    }
    Ok(())
}

/// Escape LIKE-special bytes (`\`, `%`, `_`) in a literal so it can be
/// used as a prefix in `LIKE … ESCAPE '\'`. Tag grammar allows `_`, so
/// this is not optional — an unescaped `_` would match any single
/// character and bleed siblings into the prefix match.
fn escape_like_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Distinct file paths that carry `tag_path` or any of its descendants
/// (`tag_path/…`). Matching is case-insensitive — the spec says
/// "case-insensitive matching, case-preserving display", and L3 Session D
/// stores `tag_path` with the case as written. Ordered by `file_path`
/// for stable rendering.
///
/// Used by `query_tag_page` to back the virtual tag-page listing.
pub async fn files_for_tag_prefix(
    conn: &IndexConn,
    tag_path: &str,
) -> Result<Vec<String>, IndexError> {
    let needle = tag_path.to_lowercase();
    let prefix_like = format!("{}/%", escape_like_literal(&needle));
    let mut rows = conn
        .connection()
        .query(
            "SELECT DISTINCT file_path FROM tags \
             WHERE LOWER(tag_path) = ?1 \
                OR LOWER(tag_path) LIKE ?2 ESCAPE '\\' \
             ORDER BY file_path",
            params![needle, prefix_like],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        out.push(path);
    }
    Ok(out)
}

/// Distinct tag paths whose lowercased form starts with `query`
/// (case-insensitive prefix), ordered by `tag_path`, capped at `limit`.
/// An empty `query` returns the first `limit` distinct tag paths. Case
/// is preserved as written (display); matching is case-insensitive.
///
/// Backs the `#` tag-autocomplete command (L3 Session F, spec §2.6).
pub async fn tag_paths_for_prefix(
    conn: &IndexConn,
    query: &str,
    limit: u32,
) -> Result<Vec<String>, IndexError> {
    let needle = query.to_lowercase();
    let prefix_like = format!("{}%", escape_like_literal(&needle));
    let mut rows = conn
        .connection()
        .query(
            "SELECT DISTINCT tag_path FROM tags \
             WHERE ?1 = '' OR LOWER(tag_path) LIKE ?2 ESCAPE '\\' \
             ORDER BY tag_path \
             LIMIT ?3",
            params![needle, prefix_like, i64::from(limit)],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

/// All tag rows for a given file, ordered by `(source, tag_path)` so
/// inline tags come before frontmatter ones and each group is
/// lexicographic.
pub async fn tags_for_file(conn: &IndexConn, file_path: &str) -> Result<Vec<TagRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT tag_path, source FROM tags WHERE file_path = ?1 \
             ORDER BY source, tag_path",
            params![file_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let tag_path: String = row.get(0)?;
        let source_str: String = row.get(1)?;
        let source = match source_str.as_str() {
            "inline" => TagSource::Inline,
            "frontmatter" => TagSource::Frontmatter,
            other => {
                return Err(IndexError::LibSql(libsql::Error::Misuse(format!(
                    "unknown tags.source: {other}"
                ))));
            }
        };
        out.push(TagRow { tag_path, source });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::TempDir;

    async fn seed_file(conn: &IndexConn, path: &str) {
        conn.connection()
            .execute(
                "INSERT INTO files \
                 (path, type_id, size_bytes, mtime_unix, content_hash, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', 0, 0, 0)",
                params![path],
            )
            .await
            .expect("seed files row");
    }

    fn row(tag: &str, source: TagSource) -> TagRow {
        TagRow {
            tag_path: tag.into(),
            source,
        }
    }

    async fn open_test_index() -> (TempDir, IndexConn) {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().join("index.db");
        let conn = open_index(&path).await.expect("open");
        (dir, conn)
    }

    #[tokio::test]
    async fn replace_then_lookup_round_trip() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let rows = vec![
            row("todo", TagSource::Inline),
            row("project/cubical", TagSource::Frontmatter),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        // Ordering is (source, tag_path) so inline ('inline' < 'frontmatter'
        // lexicographically? — actually 'frontmatter' < 'inline'). Both
        // strings are stable; assert by set rather than order.
        assert_eq!(got.len(), 2);
        assert!(got.contains(&row("todo", TagSource::Inline)));
        assert!(got.contains(&row("project/cubical", TagSource::Frontmatter)));
    }

    #[tokio::test]
    async fn replace_is_atomic() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("old", TagSource::Inline)])
            .await
            .expect("first");
        replace_tags_for_file(&conn, "a.md", &[row("new", TagSource::Inline)])
            .await
            .expect("second");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got, vec![row("new", TagSource::Inline)]);
    }

    #[tokio::test]
    async fn duplicate_same_triple_is_idempotent() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        // Same tag at multiple positions feeds the same triple — should
        // collapse to one row per the PK, via INSERT OR IGNORE.
        let rows = vec![
            row("todo", TagSource::Inline),
            row("todo", TagSource::Inline),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got, vec![row("todo", TagSource::Inline)]);
    }

    #[tokio::test]
    async fn same_tag_different_source_is_two_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let rows = vec![
            row("todo", TagSource::Inline),
            row("todo", TagSource::Frontmatter),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 2);
    }

    #[tokio::test]
    async fn empty_rows_clears_existing_tags() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .expect("seed");
        replace_tags_for_file(&conn, "a.md", &[])
            .await
            .expect("clear");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn files_for_tag_prefix_exact_match_returns_carriers() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        seed_file(&conn, "c.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .expect("a");
        replace_tags_for_file(&conn, "b.md", &[row("todo", TagSource::Frontmatter)])
            .await
            .expect("b");
        replace_tags_for_file(&conn, "c.md", &[row("done", TagSource::Inline)])
            .await
            .expect("c");
        let got = files_for_tag_prefix(&conn, "todo").await.expect("query");
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_includes_descendants() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "parent.md").await;
        seed_file(&conn, "child.md").await;
        seed_file(&conn, "grand.md").await;
        seed_file(&conn, "sibling.md").await;
        replace_tags_for_file(&conn, "parent.md", &[row("project", TagSource::Inline)])
            .await
            .expect("parent");
        replace_tags_for_file(
            &conn,
            "child.md",
            &[row("project/cubical", TagSource::Inline)],
        )
        .await
        .expect("child");
        replace_tags_for_file(
            &conn,
            "grand.md",
            &[row("project/cubical/l3", TagSource::Inline)],
        )
        .await
        .expect("grand");
        replace_tags_for_file(&conn, "sibling.md", &[row("projection", TagSource::Inline)])
            .await
            .expect("sibling");

        let got = files_for_tag_prefix(&conn, "project").await.expect("query");
        // sibling.md (tag "projection") must NOT match — prefix is
        // segment-boundary, not character-prefix.
        assert_eq!(
            got,
            vec![
                "child.md".to_string(),
                "grand.md".to_string(),
                "parent.md".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn files_for_tag_prefix_is_case_insensitive() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("ToDo", TagSource::Inline)])
            .await
            .expect("a");
        replace_tags_for_file(&conn, "b.md", &[row("TODO/today", TagSource::Frontmatter)])
            .await
            .expect("b");
        let got = files_for_tag_prefix(&conn, "todo").await.expect("lower");
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
        let got = files_for_tag_prefix(&conn, "TODO").await.expect("upper");
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_dedupes_when_same_file_has_inline_and_frontmatter() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        // Same file carries the tag both inline AND via frontmatter —
        // virtual tag pages list each file once, not once per source.
        let rows = vec![
            row("todo", TagSource::Inline),
            row("todo", TagSource::Frontmatter),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = files_for_tag_prefix(&conn, "todo").await.expect("query");
        assert_eq!(got, vec!["a.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_escapes_like_underscores() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "match.md").await;
        seed_file(&conn, "wildcard.md").await;
        replace_tags_for_file(&conn, "match.md", &[row("my_tag", TagSource::Inline)])
            .await
            .expect("match");
        // A tag with a single-char-different body must NOT bleed through
        // an unescaped LIKE `_`. (Body grammar doesn't actually allow a
        // bare `/` straight after — but in case extraction ever loosens,
        // the escape is still load-bearing.)
        replace_tags_for_file(&conn, "wildcard.md", &[row("myXtag", TagSource::Inline)])
            .await
            .expect("wildcard");
        let got = files_for_tag_prefix(&conn, "my_tag").await.expect("query");
        assert_eq!(got, vec!["match.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_unknown_returns_empty() {
        let (_dir, conn) = open_test_index().await;
        let got = files_for_tag_prefix(&conn, "nope").await.expect("query");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn tag_paths_for_prefix_distinct_prefix_match_case_insensitive() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("Project", TagSource::Inline),
                row("project/cubical", TagSource::Frontmatter),
            ],
        )
        .await
        .unwrap();
        replace_tags_for_file(&conn, "b.md", &[row("done", TagSource::Inline)])
            .await
            .unwrap();

        // Prefix match, case-insensitive; distinct across files.
        let got = tag_paths_for_prefix(&conn, "proj", 50).await.unwrap();
        assert_eq!(
            got,
            vec!["Project".to_string(), "project/cubical".to_string()]
        );
        // Non-matching prefix yields nothing.
        assert!(tag_paths_for_prefix(&conn, "zzz", 50)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn tag_paths_for_prefix_empty_query_lists_all_distinct_limited() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        // Same tag on two files must collapse to one DISTINCT row.
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .unwrap();
        replace_tags_for_file(&conn, "b.md", &[row("todo", TagSource::Frontmatter)])
            .await
            .unwrap();
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("todo", TagSource::Inline),
                row("area", TagSource::Inline),
            ],
        )
        .await
        .unwrap();

        let all = tag_paths_for_prefix(&conn, "", 50).await.unwrap();
        assert_eq!(all, vec!["area".to_string(), "todo".to_string()]);

        let limited = tag_paths_for_prefix(&conn, "", 1).await.unwrap();
        assert_eq!(limited, vec!["area".to_string()]);
    }

    #[tokio::test]
    async fn tag_paths_for_prefix_escapes_like_underscore() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("my_tag", TagSource::Inline),
                row("myXtag", TagSource::Inline),
            ],
        )
        .await
        .unwrap();
        // `_` in the query must be escaped, so it does not match `myXtag`.
        let got = tag_paths_for_prefix(&conn, "my_", 50).await.unwrap();
        assert_eq!(got, vec!["my_tag".to_string()]);
    }

    #[tokio::test]
    async fn cascade_delete_removes_tag_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .expect("seed");
        conn.connection()
            .execute("DELETE FROM files WHERE path = 'a.md'", ())
            .await
            .expect("delete file");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert!(got.is_empty(), "tag rows should cascade-delete");
    }
}
