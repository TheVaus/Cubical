use cubical_ast::{parse, Frontmatter};
use libsql::params;

use crate::vault::Vault;

pub async fn refresh_frontmatter(
    vault: &Vault,
    rel_path_str: &str,
    source: &str,
) -> Result<u32, libsql::Error> {
    let parsed = match parse_off_executor(source).await {
        Some(fm) => fm,
        None => {
            delete_rows(vault, rel_path_str).await?;
            return Ok(0);
        }
    };

    let conn = vault.index().connection();
    delete_rows(vault, rel_path_str).await?;

    if parsed.entries.is_empty() {
        return Ok(0);
    }

    let mut inserted: u32 = 0;
    for (key, value) in &parsed.entries {
        let json = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO frontmatter (file_path, key, value)
             VALUES (?1, ?2, ?3)",
            params![rel_path_str, key.as_str(), json],
        )
        .await?;
        inserted = inserted.saturating_add(1);
    }
    Ok(inserted)
}

async fn delete_rows(vault: &Vault, rel_path_str: &str) -> Result<(), libsql::Error> {
    let conn = vault.index().connection();
    conn.execute(
        "DELETE FROM frontmatter WHERE file_path = ?1",
        params![rel_path_str],
    )
    .await?;
    Ok(())
}

async fn parse_off_executor(source: &str) -> Option<Frontmatter> {
    let owned = source.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let doc = parse(&owned);
        doc.frontmatter
    })
    .await;
    match result {
        Ok(fm) => fm,
        Err(join_err) => {
            tracing::warn!(error = %join_err, "frontmatter: parse task join failed");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use libsql::Connection;
    use tempfile::tempdir;

    async fn count_rows(conn: &Connection, sql: &str) -> i64 {
        let mut rows = conn.query(sql, ()).await.expect("query");
        let row = rows.next().await.expect("next").expect("row");
        row.get::<i64>(0).expect("get")
    }

    async fn seed_files_row(vault: &Vault, rel: &str) {
        let conn = vault.index().connection();
        conn.execute(
            "INSERT OR REPLACE INTO files (
                path, type_id, size_bytes, mtime_unix, content_hash,
                inode, last_seen, created_at, updated_at
            ) VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
            libsql::params![rel],
        )
        .await
        .expect("seed files row");
    }

    #[tokio::test]
    async fn refresh_writes_one_row_per_key() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        let body = "---\ntitle: Hello\ntags: [a, b]\ncount: 3\n---\n\nbody\n";
        std::fs::write(&p, body).unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        let n = refresh_frontmatter(&vault, "note.md", body)
            .await
            .expect("refresh");
        assert_eq!(n, 3);

        let conn = vault.index().connection();
        assert_eq!(
            count_rows(conn, "SELECT COUNT(*) FROM frontmatter").await,
            3
        );
        assert_eq!(
            count_rows(conn, "SELECT COUNT(*) FROM frontmatter WHERE key = 'title'").await,
            1
        );
    }

    #[tokio::test]
    async fn refresh_replaces_old_rows_on_re_run() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        let first = "---\ntitle: A\nstatus: draft\n---\n";
        std::fs::write(&p, first).unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        refresh_frontmatter(&vault, "note.md", first)
            .await
            .expect("first");

        let second = "---\nheading: B\n---\n";
        std::fs::write(&p, second).unwrap();
        refresh_frontmatter(&vault, "note.md", second)
            .await
            .expect("second");

        let conn = vault.index().connection();
        assert_eq!(
            count_rows(conn, "SELECT COUNT(*) FROM frontmatter").await,
            1
        );
        assert_eq!(
            count_rows(
                conn,
                "SELECT COUNT(*) FROM frontmatter WHERE key = 'heading'"
            )
            .await,
            1
        );
        assert_eq!(
            count_rows(
                conn,
                "SELECT COUNT(*) FROM frontmatter WHERE key = 'status'"
            )
            .await,
            0
        );
    }

    #[tokio::test]
    async fn malformed_yaml_writes_no_rows_and_does_not_error() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        let body = "---\ntitle: : :\n  - bad\n---\n\nbody\n";
        std::fs::write(&p, body).unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        let n = refresh_frontmatter(&vault, "note.md", body)
            .await
            .expect("refresh");
        assert_eq!(n, 0);

        let conn = vault.index().connection();
        assert_eq!(
            count_rows(conn, "SELECT COUNT(*) FROM frontmatter").await,
            0
        );
    }

    #[tokio::test]
    async fn no_frontmatter_writes_no_rows() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        let body = "# Just a heading\n";
        std::fs::write(&p, body).unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        let n = refresh_frontmatter(&vault, "note.md", body)
            .await
            .expect("refresh");
        assert_eq!(n, 0);
    }
}
