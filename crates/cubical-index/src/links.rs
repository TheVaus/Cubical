//! Queries against the L3 `links` table.
//!
//! The schema is in `migrations/003_links.sql`. One row per wiki-link
//! occurrence in a source file; `target_path` is `None` when the link
//! could not be resolved at extraction time. See `docs/layer-3-spec.md`
//! §2.1 and `docs/architecture/document-model.md` §5.2.

use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

/// One row inserted into the `links` table.
///
/// `target_path` is `None` at extraction time when resolution failed
/// (e.g. the target file does not exist yet, or the wiki-link string
/// resolves ambiguously). The row is still kept so the backlinks UI
/// can surface unresolved links and a later rename can re-resolve.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkRow {
    /// The wiki-link target as written, with anchor stripped (so it's
    /// just the file-name-ish portion).
    pub target_raw: String,
    /// The resolved vault-relative path, if resolution succeeded.
    pub target_path: Option<String>,
    /// `"heading"` or `"block"`, or `None` if the link had no anchor.
    pub anchor_kind: Option<String>,
    /// The anchor text (heading text or block id), or `None`.
    pub anchor_value: Option<String>,
    /// The optional `|display` text.
    pub display_text: Option<String>,
    /// `true` when the link was written `![[…]]`.
    pub is_embed: bool,
    /// Byte offset of the link's opener within its source file. Used to
    /// order rows by appearance.
    pub position: u64,
}

/// Replace the entire set of link rows for `source_path`.
///
/// "Delete-then-insert" semantics keyed on `source_path`: any prior
/// rows for the file are removed, then `rows` is inserted in order.
/// `rows` may be empty — in that case the call simply clears the
/// file's link rows.
///
/// The DELETE and INSERTs are not wrapped in their own transaction —
/// they execute directly on the caller's connection so they participate
/// in any outer transaction the caller has open (the scan + watcher
/// hot paths run them inside a per-batch tx for atomicity). This
/// mirrors `cubical_core::vault::refresh_frontmatter`.
pub async fn replace_links_for_file(
    conn: &IndexConn,
    source_path: &str,
    rows: &[LinkRow],
) -> Result<(), IndexError> {
    let c = conn.connection();
    c.execute(
        "DELETE FROM links WHERE source_path = ?1",
        params![source_path],
    )
    .await?;
    for r in rows {
        c.execute(
            "INSERT INTO links \
             (source_path, target_raw, target_path, anchor_kind, anchor_value, \
              display_text, is_embed, position) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                source_path,
                r.target_raw.clone(),
                r.target_path.clone(),
                r.anchor_kind.clone(),
                r.anchor_value.clone(),
                r.display_text.clone(),
                i64::from(r.is_embed),
                r.position as i64,
            ],
        )
        .await?;
    }
    Ok(())
}

/// All link rows whose `source_path` equals the argument, ordered by
/// `position` (source order).
pub async fn links_from(
    conn: &IndexConn,
    source_path: &str,
) -> Result<Vec<LinkRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT target_raw, target_path, anchor_kind, anchor_value, \
                    display_text, is_embed, position \
             FROM links WHERE source_path = ?1 ORDER BY position",
            params![source_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row_to_link(&row)?);
    }
    Ok(out)
}

/// All link rows whose `target_path` equals the argument (backlinks).
/// Ordered by `(source_path, position)` so a per-file grouping is stable.
pub async fn links_to(
    conn: &IndexConn,
    target_path: &str,
) -> Result<Vec<LinkRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT target_raw, target_path, anchor_kind, anchor_value, \
                    display_text, is_embed, position \
             FROM links WHERE target_path = ?1 ORDER BY source_path, position",
            params![target_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row_to_link(&row)?);
    }
    Ok(out)
}

fn row_to_link(row: &libsql::Row) -> Result<LinkRow, IndexError> {
    let is_embed_int: i64 = row.get(5)?;
    let position_int: i64 = row.get(6)?;
    Ok(LinkRow {
        target_raw: row.get(0)?,
        target_path: row.get(1)?,
        anchor_kind: row.get(2)?,
        anchor_value: row.get(3)?,
        display_text: row.get(4)?,
        is_embed: is_embed_int != 0,
        position: position_int.try_into().unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::TempDir;

    /// Insert a minimal `files` row so the `links.source_path` FK is
    /// satisfied. The L3 link index doesn't care about the column
    /// values — only that a parent row exists.
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

    fn row(target_raw: &str, target_path: Option<&str>) -> LinkRow {
        LinkRow {
            target_raw: target_raw.into(),
            target_path: target_path.map(String::from),
            anchor_kind: None,
            anchor_value: None,
            display_text: None,
            is_embed: false,
            position: 0,
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
        let rows = vec![row("Other Note", Some("other.md"))];
        replace_links_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert_eq!(got, rows);
    }

    #[tokio::test]
    async fn links_to_returns_backlinks() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        let rows_a = vec![row("Target", Some("target.md"))];
        let rows_b = vec![row("Target", Some("target.md"))];
        replace_links_for_file(&conn, "a.md", &rows_a)
            .await
            .expect("a");
        replace_links_for_file(&conn, "b.md", &rows_b)
            .await
            .expect("b");
        let back = links_to(&conn, "target.md").await.expect("backlinks");
        assert_eq!(back.len(), 2);
    }

    #[tokio::test]
    async fn replace_is_atomic() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_links_for_file(&conn, "a.md", &[row("Old", Some("old.md"))])
            .await
            .expect("first");
        replace_links_for_file(&conn, "a.md", &[row("New", Some("new.md"))])
            .await
            .expect("second");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].target_raw, "New");
    }

    #[tokio::test]
    async fn position_orders_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let mut r1 = row("Second", Some("s.md"));
        r1.position = 100;
        let mut r2 = row("First", Some("f.md"));
        r2.position = 10;
        replace_links_for_file(&conn, "a.md", &[r1, r2])
            .await
            .expect("replace");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].target_raw, "First");
        assert_eq!(got[1].target_raw, "Second");
    }

    #[tokio::test]
    async fn cascade_delete_removes_link_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_links_for_file(&conn, "a.md", &[row("X", Some("x.md"))])
            .await
            .expect("replace");
        // Delete the parent file row; the FK ON DELETE CASCADE should
        // remove the link rows too.
        conn.connection()
            .execute("DELETE FROM files WHERE path = 'a.md'", ())
            .await
            .expect("delete file");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert!(got.is_empty(), "link rows should cascade-delete");
    }
}
