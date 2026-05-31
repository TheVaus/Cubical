//! Queries against the L3 `pending_rewrites` table (migration 006,
//! schema in `migrations/006_pending_rewrites.sql`). Each row is a
//! deferred per-file token rewrite produced by a rename operation
//! (file / tag / block-id); rows are grouped by `rename_op_id` so a
//! single undo deletes exactly what one rename enqueued. See
//! `docs/architecture/document-model.md` §5.7 and
//! `docs/layer-3-spec.md` §2.10.

use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

/// Kind of textual rewrite a pending row encodes.
///
/// String form stored in the `rewrite_kind` column matches the values
/// listed in the schema comment: `"wiki_link"`, `"tag"`, `"block_ref"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewriteKind {
    /// `[[old]]` → `[[new]]`. `old_token` / `new_token` are bare wiki-link
    /// targets (no `[[`, no `|display`, no `#anchor`).
    WikiLink,
    /// `#old` → `#new` (and nested-prefix variants). Tokens are stored
    /// without the leading `#`.
    Tag,
    /// `^old` block-id rewrite: both the defining `^id` line and any
    /// `[[file#^id]]` referrer. Tokens are stored without the leading `^`.
    BlockRef,
}

impl RewriteKind {
    /// String form stored in the `rewrite_kind` column.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            RewriteKind::WikiLink => "wiki_link",
            RewriteKind::Tag => "tag",
            RewriteKind::BlockRef => "block_ref",
        }
    }

    /// Parse the column value back into a [`RewriteKind`]. Unknown
    /// strings produce [`IndexError::UnknownEnum`] with full context so
    /// the caller can log which row tripped it.
    pub fn from_column(value: &str) -> Result<Self, IndexError> {
        match value {
            "wiki_link" => Ok(RewriteKind::WikiLink),
            "tag" => Ok(RewriteKind::Tag),
            "block_ref" => Ok(RewriteKind::BlockRef),
            other => Err(IndexError::UnknownEnum {
                table: "pending_rewrites",
                column: "rewrite_kind",
                value: other.to_string(),
            }),
        }
    }
}

/// One row read back from the `pending_rewrites` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRewriteRow {
    /// Auto-increment row id.
    pub id: i64,
    /// File the rewrite should be applied to.
    pub target_file: String,
    /// What kind of token this rewrite encodes.
    pub rewrite_kind: RewriteKind,
    /// The token as written on disk before the rewrite.
    pub old_token: String,
    /// The token to substitute in.
    pub new_token: String,
    /// Unix seconds at enqueue time.
    pub created_at: i64,
    /// Rename operation that produced this row. Multiple rows share
    /// this id when the originating rename touched multiple files.
    pub rename_op_id: i64,
}

/// A new row to insert into `pending_rewrites`. Mirrors
/// [`PendingRewriteRow`] minus the auto-incremented `id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPendingRewrite {
    /// File the rewrite should be applied to.
    pub target_file: String,
    /// What kind of token this rewrite encodes.
    pub rewrite_kind: RewriteKind,
    /// The token as written on disk before the rewrite.
    pub old_token: String,
    /// The token to substitute in.
    pub new_token: String,
    /// Unix seconds at enqueue time.
    pub created_at: i64,
    /// Rename operation that produced this row.
    pub rename_op_id: i64,
}

/// A `rename_op_id` group surfaced for the status-bar undo dropdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameOpRow {
    /// The grouped rename operation id.
    pub rename_op_id: i64,
    /// How many pending rows belong to this op.
    pub row_count: i64,
    /// Earliest `created_at` in the group; effectively the time the
    /// rename was enqueued.
    pub created_at_min: i64,
    /// A representative `rewrite_kind` for the group, chosen
    /// deterministically (`MIN(rewrite_kind)` in lexicographic order).
    pub representative_kind: RewriteKind,
}

/// Append pending rewrite rows to the cache.
///
/// Runs on the caller's connection without an inner transaction so
/// callers can batch enqueue + count + emit-event inside one outer
/// transaction. Empty `rows` is a no-op.
pub async fn enqueue_pending(
    conn: &IndexConn,
    rows: &[NewPendingRewrite],
) -> Result<(), IndexError> {
    if rows.is_empty() {
        return Ok(());
    }
    let c = conn.connection();
    for r in rows {
        c.execute(
            "INSERT INTO pending_rewrites \
             (target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                r.target_file.clone(),
                r.rewrite_kind.as_str(),
                r.old_token.clone(),
                r.new_token.clone(),
                r.created_at,
                r.rename_op_id
            ],
        )
        .await?;
    }
    Ok(())
}

/// All pending rows for a given target file, ordered by `created_at`
/// then `id`. The id tiebreaker makes the order deterministic even when
/// two rows share a `created_at` (common in test fixtures and possible
/// in production for rapid renames).
pub async fn pending_for_target(
    conn: &IndexConn,
    target_file: &str,
) -> Result<Vec<PendingRewriteRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT id, target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id \
             FROM pending_rewrites \
             WHERE target_file = ?1 \
             ORDER BY created_at ASC, id ASC",
            params![target_file],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let kind_str: String = row.get(2)?;
        out.push(PendingRewriteRow {
            id: row.get(0)?,
            target_file: row.get(1)?,
            rewrite_kind: RewriteKind::from_column(&kind_str)?,
            old_token: row.get(3)?,
            new_token: row.get(4)?,
            created_at: row.get(5)?,
            rename_op_id: row.get(6)?,
        });
    }
    Ok(out)
}

/// All distinct target file paths that have at least one pending row.
/// Sorted ascending for stable iteration.
pub async fn pending_targets(conn: &IndexConn) -> Result<Vec<String>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT DISTINCT target_file FROM pending_rewrites ORDER BY target_file ASC",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get(0)?);
    }
    Ok(out)
}

/// Total number of pending rows across all targets.
pub async fn pending_count_total(conn: &IndexConn) -> Result<i64, IndexError> {
    let mut rows = conn
        .connection()
        .query("SELECT COUNT(*) FROM pending_rewrites", ())
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(0);
    };
    Ok(row.get::<i64>(0)?)
}

/// Number of pending rows for a single target file.
pub async fn pending_count_for_target(
    conn: &IndexConn,
    target_file: &str,
) -> Result<i64, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT COUNT(*) FROM pending_rewrites WHERE target_file = ?1",
            params![target_file],
        )
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(0);
    };
    Ok(row.get::<i64>(0)?)
}

/// Per-target breakdown sorted by count descending, with `target_file`
/// as the tiebreaker for stable output.
pub async fn pending_count_breakdown(conn: &IndexConn) -> Result<Vec<(String, i64)>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT target_file, COUNT(*) AS n \
             FROM pending_rewrites \
             GROUP BY target_file \
             ORDER BY n DESC, target_file ASC",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        let n: i64 = row.get(1)?;
        out.push((path, n));
    }
    Ok(out)
}

/// Delete every pending row belonging to `rename_op_id`. Returns the
/// number of rows removed; `0` if the op id is unknown (idempotent
/// from the caller's perspective).
pub async fn delete_rename_op(conn: &IndexConn, rename_op_id: i64) -> Result<u64, IndexError> {
    Ok(conn
        .connection()
        .execute(
            "DELETE FROM pending_rewrites WHERE rename_op_id = ?1",
            params![rename_op_id],
        )
        .await?)
}

/// Delete every pending row for `target_file`. Returns the number of
/// rows removed.
pub async fn delete_pending_for_target(
    conn: &IndexConn,
    target_file: &str,
) -> Result<u64, IndexError> {
    Ok(conn
        .connection()
        .execute(
            "DELETE FROM pending_rewrites WHERE target_file = ?1",
            params![target_file],
        )
        .await?)
}

/// Most-recent rename ops, newest first. The representative kind is
/// `MIN(rewrite_kind)` in lexicographic order — deterministic but
/// otherwise arbitrary; the J.2 dropdown only uses it for a leading
/// icon, not for semantic dispatch.
pub async fn list_recent_rename_ops(
    conn: &IndexConn,
    limit: i64,
) -> Result<Vec<RenameOpRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT rename_op_id, COUNT(*) AS n, MIN(created_at) AS first_seen, \
                    MIN(rewrite_kind) AS kind \
             FROM pending_rewrites \
             GROUP BY rename_op_id \
             ORDER BY MAX(created_at) DESC, rename_op_id DESC \
             LIMIT ?1",
            params![limit],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let kind_str: String = row.get(3)?;
        out.push(RenameOpRow {
            rename_op_id: row.get(0)?,
            row_count: row.get(1)?,
            created_at_min: row.get(2)?,
            representative_kind: RewriteKind::from_column(&kind_str)?,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::TempDir;

    async fn open_test_index() -> (TempDir, IndexConn) {
        let dir = TempDir::new().expect("tmpdir");
        let conn = open_index(&dir.path().join("index.db"))
            .await
            .expect("open");
        (dir, conn)
    }

    fn row(
        target: &str,
        kind: RewriteKind,
        old: &str,
        new: &str,
        created_at: i64,
        op: i64,
    ) -> NewPendingRewrite {
        NewPendingRewrite {
            target_file: target.into(),
            rewrite_kind: kind,
            old_token: old.into(),
            new_token: new.into(),
            created_at,
            rename_op_id: op,
        }
    }

    #[tokio::test]
    async fn enqueue_and_list_round_trip() {
        let (_d, conn) = open_test_index().await;
        let rows = vec![
            row("a.md", RewriteKind::WikiLink, "Old", "New", 10, 1),
            row("a.md", RewriteKind::Tag, "old", "new", 20, 1),
            row("a.md", RewriteKind::BlockRef, "abc", "xyz", 30, 1),
        ];
        enqueue_pending(&conn, &rows).await.unwrap();

        let got = pending_for_target(&conn, "a.md").await.unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].old_token, "Old");
        assert_eq!(got[0].rewrite_kind, RewriteKind::WikiLink);
        assert_eq!(got[1].old_token, "old");
        assert_eq!(got[1].rewrite_kind, RewriteKind::Tag);
        assert_eq!(got[2].old_token, "abc");
        assert_eq!(got[2].rewrite_kind, RewriteKind::BlockRef);
        for r in &got {
            assert_eq!(r.target_file, "a.md");
            assert_eq!(r.rename_op_id, 1);
        }
    }

    #[tokio::test]
    async fn pending_for_target_orders_by_created_at_then_id() {
        let (_d, conn) = open_test_index().await;
        // Three rows with the same created_at; insertion order (id) must
        // be the tiebreaker.
        enqueue_pending(
            &conn,
            &[
                row("a.md", RewriteKind::WikiLink, "first", "x", 100, 1),
                row("a.md", RewriteKind::WikiLink, "second", "x", 100, 1),
                row("a.md", RewriteKind::WikiLink, "third", "x", 100, 1),
            ],
        )
        .await
        .unwrap();

        // And one row with an earlier timestamp inserted last — must
        // still come first by created_at.
        enqueue_pending(
            &conn,
            &[row("a.md", RewriteKind::WikiLink, "zero", "x", 50, 1)],
        )
        .await
        .unwrap();

        let got = pending_for_target(&conn, "a.md").await.unwrap();
        let tokens: Vec<&str> = got.iter().map(|r| r.old_token.as_str()).collect();
        assert_eq!(tokens, vec!["zero", "first", "second", "third"]);
    }

    #[tokio::test]
    async fn pending_targets_returns_distinct_sorted() {
        let (_d, conn) = open_test_index().await;
        enqueue_pending(
            &conn,
            &[
                row("c.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("a.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("a.md", RewriteKind::Tag, "x", "y", 11, 1),
                row("b.md", RewriteKind::WikiLink, "x", "y", 12, 1),
            ],
        )
        .await
        .unwrap();

        let got = pending_targets(&conn).await.unwrap();
        assert_eq!(got, vec!["a.md".to_string(), "b.md".into(), "c.md".into()]);
    }

    #[tokio::test]
    async fn pending_count_total_and_per_target() {
        let (_d, conn) = open_test_index().await;
        assert_eq!(pending_count_total(&conn).await.unwrap(), 0);
        assert_eq!(pending_count_for_target(&conn, "a.md").await.unwrap(), 0);

        enqueue_pending(
            &conn,
            &[
                row("a.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("a.md", RewriteKind::Tag, "x", "y", 11, 1),
                row("b.md", RewriteKind::WikiLink, "x", "y", 12, 1),
            ],
        )
        .await
        .unwrap();
        assert_eq!(pending_count_total(&conn).await.unwrap(), 3);
        assert_eq!(pending_count_for_target(&conn, "a.md").await.unwrap(), 2);
        assert_eq!(pending_count_for_target(&conn, "b.md").await.unwrap(), 1);
        assert_eq!(
            pending_count_for_target(&conn, "missing.md").await.unwrap(),
            0
        );

        let removed = delete_pending_for_target(&conn, "a.md").await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(pending_count_total(&conn).await.unwrap(), 1);
        assert_eq!(pending_count_for_target(&conn, "a.md").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn pending_count_breakdown_orders_by_count_desc() {
        let (_d, conn) = open_test_index().await;
        // a.md: 1 row, b.md: 3 rows, c.md: 2 rows -> ordering must be b, c, a.
        enqueue_pending(
            &conn,
            &[
                row("a.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("b.md", RewriteKind::WikiLink, "x", "y", 11, 1),
                row("b.md", RewriteKind::Tag, "x", "y", 12, 1),
                row("b.md", RewriteKind::BlockRef, "x", "y", 13, 1),
                row("c.md", RewriteKind::WikiLink, "x", "y", 14, 1),
                row("c.md", RewriteKind::Tag, "x", "y", 15, 1),
            ],
        )
        .await
        .unwrap();

        let got = pending_count_breakdown(&conn).await.unwrap();
        assert_eq!(
            got,
            vec![
                ("b.md".to_string(), 3),
                ("c.md".to_string(), 2),
                ("a.md".to_string(), 1),
            ]
        );
    }

    #[tokio::test]
    async fn delete_rename_op_removes_only_matching_op() {
        let (_d, conn) = open_test_index().await;
        enqueue_pending(
            &conn,
            &[
                row("a.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("b.md", RewriteKind::WikiLink, "x", "y", 11, 1),
                row("c.md", RewriteKind::Tag, "x", "y", 12, 2),
                row("d.md", RewriteKind::Tag, "x", "y", 13, 2),
            ],
        )
        .await
        .unwrap();

        let removed = delete_rename_op(&conn, 1).await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(pending_count_total(&conn).await.unwrap(), 2);

        // Op 2's rows survived.
        let surviving = pending_targets(&conn).await.unwrap();
        assert_eq!(surviving, vec!["c.md".to_string(), "d.md".into()]);

        // Deleting an unknown op is a no-op and returns 0.
        let removed = delete_rename_op(&conn, 999).await.unwrap();
        assert_eq!(removed, 0);
        assert_eq!(pending_count_total(&conn).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn delete_pending_for_target_removes_only_matching_target() {
        let (_d, conn) = open_test_index().await;
        enqueue_pending(
            &conn,
            &[
                row("a.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("a.md", RewriteKind::Tag, "x", "y", 11, 1),
                row("b.md", RewriteKind::WikiLink, "x", "y", 12, 1),
            ],
        )
        .await
        .unwrap();

        let removed = delete_pending_for_target(&conn, "a.md").await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(pending_count_total(&conn).await.unwrap(), 1);
        let survivors = pending_targets(&conn).await.unwrap();
        assert_eq!(survivors, vec!["b.md".to_string()]);

        // Deleting for an unknown target is a no-op.
        let removed = delete_pending_for_target(&conn, "ghost.md").await.unwrap();
        assert_eq!(removed, 0);
    }

    #[tokio::test]
    async fn list_recent_rename_ops_limits_and_orders_by_created_at_desc() {
        let (_d, conn) = open_test_index().await;
        // Four ops with increasing created_at; limit=2 should return ops 4, 3.
        enqueue_pending(
            &conn,
            &[
                row("a.md", RewriteKind::WikiLink, "x", "y", 10, 1),
                row("a.md", RewriteKind::WikiLink, "x", "y", 20, 2),
                row("b.md", RewriteKind::Tag, "x", "y", 30, 3),
                row("c.md", RewriteKind::BlockRef, "x", "y", 40, 4),
                // Extra row in op 3 so we can sanity-check row_count.
                row("b.md", RewriteKind::Tag, "x", "y", 35, 3),
            ],
        )
        .await
        .unwrap();

        let got = list_recent_rename_ops(&conn, 2).await.unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].rename_op_id, 4);
        assert_eq!(got[0].row_count, 1);
        assert_eq!(got[0].representative_kind, RewriteKind::BlockRef);
        assert_eq!(got[0].created_at_min, 40);
        assert_eq!(got[1].rename_op_id, 3);
        assert_eq!(got[1].row_count, 2);
        assert_eq!(got[1].representative_kind, RewriteKind::Tag);
        assert_eq!(got[1].created_at_min, 30);
    }

    #[tokio::test]
    async fn unknown_rewrite_kind_in_row_errors_cleanly() {
        let (_d, conn) = open_test_index().await;
        // Insert a row by hand with a bogus rewrite_kind to simulate a
        // corrupt / out-of-band write. Read-back should produce an
        // IndexError, not panic.
        conn.connection()
            .execute(
                "INSERT INTO pending_rewrites \
                 (target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id) \
                 VALUES ('a.md', 'bogus', 'x', 'y', 0, 1)",
                (),
            )
            .await
            .expect("raw insert");

        let err = pending_for_target(&conn, "a.md")
            .await
            .expect_err("should error");
        match err {
            IndexError::UnknownEnum {
                table,
                column,
                value,
            } => {
                assert_eq!(table, "pending_rewrites");
                assert_eq!(column, "rewrite_kind");
                assert_eq!(value, "bogus");
            }
            other => panic!("expected UnknownEnum, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_kind_string_round_trips() {
        for k in [
            RewriteKind::WikiLink,
            RewriteKind::Tag,
            RewriteKind::BlockRef,
        ] {
            assert_eq!(RewriteKind::from_column(k.as_str()).unwrap(), k);
        }
    }
}
