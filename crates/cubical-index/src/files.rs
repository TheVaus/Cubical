use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

#[derive(Debug, Clone)]
pub struct FileRow<'a> {
    pub path: &'a str,
    pub type_id: &'a str,
    pub size_bytes: i64,
    pub mtime_unix: i64,
    pub content_hash: &'a str,
    pub inode: Option<i64>,
    pub seen_at: i64,
}

pub async fn upsert_file(conn: &IndexConn, file: &FileRow<'_>) -> Result<(), IndexError> {
    conn.connection()
        .execute(
            "INSERT INTO files (
                 path, type_id, size_bytes, mtime_unix, content_hash,
                 inode, last_seen, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
             ON CONFLICT(path) DO UPDATE SET
                 type_id      = excluded.type_id,
                 size_bytes   = excluded.size_bytes,
                 mtime_unix   = excluded.mtime_unix,
                 content_hash = excluded.content_hash,
                 inode        = excluded.inode,
                 last_seen    = excluded.last_seen,
                 updated_at   = excluded.last_seen",
            params![
                file.path,
                file.type_id,
                file.size_bytes,
                file.mtime_unix,
                file.content_hash,
                file.inode,
                file.seen_at
            ],
        )
        .await?;
    Ok(())
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

    fn row<'a>(path: &'a str, type_id: &'a str, hash: &'a str, seen_at: i64) -> FileRow<'a> {
        FileRow {
            path,
            type_id,
            size_bytes: 1,
            mtime_unix: seen_at,
            content_hash: hash,
            inode: None,
            seen_at,
        }
    }

    async fn type_id_of(conn: &IndexConn, path: &str) -> String {
        let mut rows = conn
            .connection()
            .query("SELECT type_id FROM files WHERE path = ?1", params![path])
            .await
            .unwrap();
        rows.next()
            .await
            .unwrap()
            .unwrap()
            .get::<String>(0)
            .unwrap()
    }

    #[tokio::test]
    async fn conflicting_upsert_corrects_a_changed_type_id() {
        let (_d, conn) = fresh().await;

        upsert_file(&conn, &row("note.md", "markdown", "aaa", 10))
            .await
            .unwrap();
        upsert_file(&conn, &row("note.md", "binary", "bbb", 20))
            .await
            .unwrap();

        assert_eq!(type_id_of(&conn, "note.md").await, "binary");
    }

    #[tokio::test]
    async fn conflicting_upsert_keeps_created_at_and_advances_updated_at() {
        let (_d, conn) = fresh().await;

        upsert_file(&conn, &row("note.md", "markdown", "aaa", 10))
            .await
            .unwrap();
        upsert_file(&conn, &row("note.md", "markdown", "bbb", 20))
            .await
            .unwrap();

        let mut rows = conn
            .connection()
            .query(
                "SELECT created_at, updated_at, last_seen, content_hash FROM files WHERE path = ?1",
                params!["note.md"],
            )
            .await
            .unwrap();
        let r = rows.next().await.unwrap().unwrap();
        assert_eq!(r.get::<i64>(0).unwrap(), 10);
        assert_eq!(r.get::<i64>(1).unwrap(), 20);
        assert_eq!(r.get::<i64>(2).unwrap(), 20);
        assert_eq!(r.get::<String>(3).unwrap(), "bbb");
    }
}
