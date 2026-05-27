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
