//! Queries against the `folders` table (migration 007, schema in
//! `migrations/007_folders.sql`).
//!
//! The file tree is otherwise derived from `files` paths, so an empty
//! directory has no representation. This table records every directory
//! in the vault so empty folders still render. It is derived,
//! rebuildable state — the on-disk directory is the source of truth,
//! re-discovered by every scan. Paths are vault-relative with no
//! leading or trailing slash; the vault root is never stored.

use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

/// Upsert a folder row. `created_at` is preserved on conflict so a
/// re-scan / re-create doesn't reset it; `last_seen` is always bumped so
/// the staleness sweep can tell which rows a scan touched.
pub async fn upsert_folder(conn: &IndexConn, path: &str, now: i64) -> Result<(), IndexError> {
    conn.connection()
        .execute(
            "INSERT INTO folders (path, created_at, last_seen) VALUES (?1, ?2, ?2)
             ON CONFLICT(path) DO UPDATE SET last_seen = excluded.last_seen",
            params![path, now],
        )
        .await?;
    Ok(())
}

/// Delete a single folder row. No-op if the path isn't tracked.
pub async fn delete_folder(conn: &IndexConn, path: &str) -> Result<(), IndexError> {
    conn.connection()
        .execute("DELETE FROM folders WHERE path = ?1", params![path])
        .await?;
    Ok(())
}

/// Delete every folder row not seen since `cutoff` (i.e. whose
/// `last_seen < cutoff`). Returns the number of rows swept. Used by the
/// scan to drop folders deleted while the app wasn't watching.
pub async fn sweep_stale_folders(conn: &IndexConn, cutoff: i64) -> Result<u64, IndexError> {
    let n = conn
        .connection()
        .execute("DELETE FROM folders WHERE last_seen < ?1", params![cutoff])
        .await?;
    Ok(n)
}

/// All tracked folder paths, ascending. Drives the file-tree merge that
/// makes empty folders visible.
pub async fn list_folders(conn: &IndexConn) -> Result<Vec<String>, IndexError> {
    let mut rows = conn
        .connection()
        .query("SELECT path FROM folders ORDER BY path", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::tempdir;

    async fn fresh() -> (tempfile::TempDir, IndexConn) {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db"))
            .await
            .expect("open");
        (dir, conn)
    }

    #[tokio::test]
    async fn upsert_then_list_returns_sorted_paths() {
        let (_d, conn) = fresh().await;
        upsert_folder(&conn, "projects", 10).await.unwrap();
        upsert_folder(&conn, "archive", 10).await.unwrap();
        upsert_folder(&conn, "projects/2026", 10).await.unwrap();
        assert_eq!(
            list_folders(&conn).await.unwrap(),
            vec!["archive", "projects", "projects/2026"],
        );
    }

    #[tokio::test]
    async fn upsert_preserves_created_at_and_bumps_last_seen() {
        let (_d, conn) = fresh().await;
        upsert_folder(&conn, "notes", 100).await.unwrap();
        upsert_folder(&conn, "notes", 200).await.unwrap();
        let mut rows = conn
            .connection()
            .query(
                "SELECT created_at, last_seen FROM folders WHERE path = 'notes'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(row.get::<i64>(0).unwrap(), 100, "created_at preserved");
        assert_eq!(row.get::<i64>(1).unwrap(), 200, "last_seen bumped");
    }

    #[tokio::test]
    async fn delete_removes_the_row() {
        let (_d, conn) = fresh().await;
        upsert_folder(&conn, "gone", 10).await.unwrap();
        delete_folder(&conn, "gone").await.unwrap();
        assert!(list_folders(&conn).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sweep_drops_only_rows_older_than_cutoff() {
        let (_d, conn) = fresh().await;
        upsert_folder(&conn, "stale", 5).await.unwrap();
        upsert_folder(&conn, "fresh", 50).await.unwrap();
        let swept = sweep_stale_folders(&conn, 10).await.unwrap();
        assert_eq!(swept, 1);
        assert_eq!(list_folders(&conn).await.unwrap(), vec!["fresh"]);
    }
}
