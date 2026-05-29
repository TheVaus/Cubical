//! Queries against the L3 `blocks` + `block_refs` tables (migration 005,
//! schema in `migrations/005_blocks.sql`). `blocks` holds `^block-id`
//! definitions per file; `block_refs` holds resolved `[[#^id]]` refs.
//! "Broken" refs are computed at query time via an anti-join to
//! `blocks`. See `docs/layer-3-spec.md` §2.7.

use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

/// One `blocks` row: a block-id definition in a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRow {
    /// Block id without the leading `^`.
    pub block_id: String,
    /// Byte offset of the line carrying the id.
    pub position_hint: u64,
}

/// One `block_refs` row: a resolved `[[target#^id]]` reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRefRow {
    /// Resolved target file path.
    pub target_file_path: String,
    /// Target block id (no `^`).
    pub target_block_id: String,
}

/// A broken block ref surfaced for vault health: a ref whose target
/// block id does not exist in `blocks`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokenBlockRef {
    /// File containing the `[[…#^id]]`.
    pub source_file_path: String,
    /// Target file the ref points at.
    pub target_file_path: String,
    /// Missing block id.
    pub target_block_id: String,
}

/// Replace all `blocks` rows for `file_path`. Delete-then-insert; runs
/// on the caller's connection (no own transaction). `last_modified` is
/// stamped now (unix seconds).
pub async fn replace_blocks_for_file(
    conn: &IndexConn,
    file_path: &str,
    rows: &[BlockRow],
) -> Result<(), IndexError> {
    let now = now_unix_secs();
    let c = conn.connection();
    c.execute(
        "DELETE FROM blocks WHERE file_path = ?1",
        params![file_path],
    )
    .await?;
    for r in rows {
        c.execute(
            "INSERT OR IGNORE INTO blocks (file_path, block_id, position_hint, last_modified) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                file_path,
                r.block_id.clone(),
                i64::try_from(r.position_hint).unwrap_or(i64::MAX),
                now
            ],
        )
        .await?;
    }
    Ok(())
}

/// All block-id definitions in `file_path`, ordered by `position_hint`.
pub async fn blocks_for_file(
    conn: &IndexConn,
    file_path: &str,
) -> Result<Vec<BlockRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT block_id, position_hint FROM blocks \
             WHERE file_path = ?1 ORDER BY position_hint",
            params![file_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let block_id: String = row.get(0)?;
        let position_hint: i64 = row.get(1)?;
        out.push(BlockRow {
            block_id,
            position_hint: u64::try_from(position_hint).unwrap_or(0),
        });
    }
    Ok(out)
}

/// Whether `(file_path, block_id)` exists in `blocks`.
pub async fn block_exists(
    conn: &IndexConn,
    file_path: &str,
    block_id: &str,
) -> Result<bool, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT 1 FROM blocks WHERE file_path = ?1 AND block_id = ?2 LIMIT 1",
            params![file_path, block_id],
        )
        .await?;
    Ok(rows.next().await?.is_some())
}

/// Replace all `block_refs` rows for `source_file_path`. Delete-then-
/// insert on the caller's connection.
pub async fn replace_block_refs_for_file(
    conn: &IndexConn,
    source_file_path: &str,
    rows: &[BlockRefRow],
) -> Result<(), IndexError> {
    let c = conn.connection();
    c.execute(
        "DELETE FROM block_refs WHERE source_file_path = ?1",
        params![source_file_path],
    )
    .await?;
    for r in rows {
        c.execute(
            "INSERT INTO block_refs (source_file_path, target_file_path, target_block_id) \
             VALUES (?1, ?2, ?3)",
            params![
                source_file_path,
                r.target_file_path.clone(),
                r.target_block_id.clone()
            ],
        )
        .await?;
    }
    Ok(())
}

/// Every block ref whose target block id is not defined in `blocks`.
/// Ordered for stable output.
pub async fn broken_block_refs(conn: &IndexConn) -> Result<Vec<BrokenBlockRef>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT r.source_file_path, r.target_file_path, r.target_block_id \
             FROM block_refs r \
             LEFT JOIN blocks b \
               ON b.file_path = r.target_file_path AND b.block_id = r.target_block_id \
             WHERE b.block_id IS NULL \
             ORDER BY r.source_file_path, r.target_file_path, r.target_block_id",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(BrokenBlockRef {
            source_file_path: row.get(0)?,
            target_file_path: row.get(1)?,
            target_block_id: row.get(2)?,
        });
    }
    Ok(out)
}

/// Unix seconds now (saturating). Local helper to avoid a chrono dep.
fn now_unix_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
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

    #[tokio::test]
    async fn replace_then_lookup_blocks() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_blocks_for_file(
            &conn,
            "a.md",
            &[BlockRow {
                block_id: "intro".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();
        assert!(block_exists(&conn, "a.md", "intro").await.unwrap());
        assert!(!block_exists(&conn, "a.md", "missing").await.unwrap());
        let got = blocks_for_file(&conn, "a.md").await.unwrap();
        assert_eq!(
            got,
            vec![BlockRow {
                block_id: "intro".into(),
                position_hint: 0
            }]
        );
    }

    #[tokio::test]
    async fn replace_blocks_is_delete_then_insert() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_blocks_for_file(
            &conn,
            "a.md",
            &[BlockRow {
                block_id: "old".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();
        replace_blocks_for_file(
            &conn,
            "a.md",
            &[BlockRow {
                block_id: "new".into(),
                position_hint: 3,
            }],
        )
        .await
        .unwrap();
        let got = blocks_for_file(&conn, "a.md").await.unwrap();
        assert_eq!(
            got,
            vec![BlockRow {
                block_id: "new".into(),
                position_hint: 3
            }]
        );
    }

    #[tokio::test]
    async fn broken_block_refs_anti_joins_blocks() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "src.md").await;
        seed_file(&conn, "tgt.md").await;
        // tgt.md defines only "present".
        replace_blocks_for_file(
            &conn,
            "tgt.md",
            &[BlockRow {
                block_id: "present".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();
        // src.md references both "present" (ok) and "gone" (broken).
        replace_block_refs_for_file(
            &conn,
            "src.md",
            &[
                BlockRefRow {
                    target_file_path: "tgt.md".into(),
                    target_block_id: "present".into(),
                },
                BlockRefRow {
                    target_file_path: "tgt.md".into(),
                    target_block_id: "gone".into(),
                },
            ],
        )
        .await
        .unwrap();
        let broken = broken_block_refs(&conn).await.unwrap();
        assert_eq!(
            broken,
            vec![BrokenBlockRef {
                source_file_path: "src.md".into(),
                target_file_path: "tgt.md".into(),
                target_block_id: "gone".into(),
            }]
        );
    }

    #[tokio::test]
    async fn deleting_file_cascades_blocks_and_refs() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_blocks_for_file(
            &conn,
            "a.md",
            &[BlockRow {
                block_id: "x".into(),
                position_hint: 0,
            }],
        )
        .await
        .unwrap();
        replace_block_refs_for_file(
            &conn,
            "a.md",
            &[BlockRefRow {
                target_file_path: "a.md".into(),
                target_block_id: "x".into(),
            }],
        )
        .await
        .unwrap();
        conn.connection()
            .execute("DELETE FROM files WHERE path = 'a.md'", ())
            .await
            .unwrap();
        assert!(blocks_for_file(&conn, "a.md").await.unwrap().is_empty());
        assert!(broken_block_refs(&conn).await.unwrap().is_empty());
    }
}
