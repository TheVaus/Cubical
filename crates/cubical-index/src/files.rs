use crate::error::IndexError;
use crate::runner::IndexConn;

pub async fn all_file_paths(conn: &IndexConn) -> Result<Vec<String>, IndexError> {
    let mut rows = conn
        .connection()
        .query("SELECT path FROM files ORDER BY path", ())
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
    use libsql::params;
    use tempfile::tempdir;

    async fn seed(conn: &IndexConn, path: &str) {
        conn.connection()
            .execute(
                "INSERT INTO files (
                     path, type_id, size_bytes, mtime_unix, content_hash,
                     inode, last_seen, created_at, updated_at
                 ) VALUES (?1, 'markdown', 0, 0, 'h', NULL, 0, 0, 0)",
                params![path],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn returns_every_path_in_sorted_order() {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        seed(&conn, "z.md").await;
        seed(&conn, "a/b.md").await;
        seed(&conn, "a.md").await;

        assert_eq!(
            all_file_paths(&conn).await.unwrap(),
            vec!["a.md", "a/b.md", "z.md"],
        );
    }

    #[tokio::test]
    async fn an_empty_table_yields_an_empty_list() {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        assert!(all_file_paths(&conn).await.unwrap().is_empty());
    }
}
