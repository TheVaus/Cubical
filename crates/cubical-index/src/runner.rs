use std::path::Path;

use libsql::{Builder, Connection, Database};

use crate::error::IndexError;
use crate::migrations::{Migration, MIGRATIONS};

pub struct IndexConn {
    _db: Database,
    conn: Connection,
}

impl IndexConn {
    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

impl std::fmt::Debug for IndexConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexConn").finish_non_exhaustive()
    }
}

pub async fn open_index(path: &Path) -> Result<IndexConn, IndexError> {
    open_index_with_migrations(path, MIGRATIONS).await
}

pub(crate) async fn open_index_with_migrations(
    path: &Path,
    migrations: &[Migration],
) -> Result<IndexConn, IndexError> {
    let db = Builder::new_local(path).build().await?;
    let conn = db.connect()?;

    conn.execute("PRAGMA foreign_keys = ON", ()).await?;

    run_migrations(&conn, migrations).await?;

    Ok(IndexConn { _db: db, conn })
}

async fn run_migrations(conn: &Connection, migrations: &[Migration]) -> Result<(), IndexError> {
    let current = read_schema_version(conn).await?;
    let highest_known = migrations.iter().map(|m| m.version).max().unwrap_or(0);

    if current > highest_known {
        return Err(IndexError::SchemaTooNew(current));
    }

    let pending: Vec<&Migration> = migrations.iter().filter(|m| m.version > current).collect();
    if pending.is_empty() {
        return Ok(());
    }

    let mut pending = pending;
    pending.sort_by_key(|m| m.version);

    let new_version = pending
        .last()
        .map(|m| m.version)
        .expect("pending is non-empty; checked above");

    let tx = conn.transaction().await?;
    for m in &pending {
        tx.execute_batch(m.up).await?;
    }
    tx.execute("DELETE FROM schema_version", ()).await?;
    tx.execute(
        "INSERT INTO schema_version (version) VALUES (?1)",
        [i64::from(new_version)],
    )
    .await?;
    tx.commit().await?;

    tracing::info!(
        from = current,
        to = new_version,
        applied = pending.len(),
        "applied schema migrations"
    );

    Ok(())
}

async fn read_schema_version(conn: &Connection) -> Result<u32, IndexError> {
    let mut rows = conn
        .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
            (),
        )
        .await?;
    if rows.next().await?.is_none() {
        return Ok(0);
    }

    let mut rows = conn
        .query("SELECT MAX(version) FROM schema_version", ())
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(0);
    };
    let v: Option<i64> = row.get(0)?;
    Ok(v.unwrap_or(0).try_into().unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn db_path(dir: &TempDir) -> PathBuf {
        dir.path().join("index.db")
    }

    async fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        let mut rows = conn.query(sql, ()).await.expect("query");
        let row = rows.next().await.expect("next").expect("row");
        row.get::<i64>(0).expect("get")
    }

    async fn table_exists(conn: &Connection, name: &str) -> bool {
        let mut rows = conn
            .query(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
            )
            .await
            .expect("query");
        rows.next().await.expect("next").is_some()
    }

    async fn index_exists(conn: &Connection, name: &str) -> bool {
        let mut rows = conn
            .query(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [name],
            )
            .await
            .expect("query");
        rows.next().await.expect("next").is_some()
    }

    const HIGHEST_KNOWN_VERSION: i64 = 7;

    #[tokio::test]
    async fn fresh_db_applies_all_known_migrations() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        let idx = open_index(&path).await.expect("open");

        let conn = idx.connection();
        assert!(table_exists(conn, "schema_version").await);
        assert!(table_exists(conn, "files").await);
        assert!(table_exists(conn, "config").await);
        assert!(table_exists(conn, "audit_log").await);

        assert!(index_exists(conn, "idx_files_type").await);
        assert!(index_exists(conn, "idx_files_inode").await);
        assert!(index_exists(conn, "idx_audit_timestamp").await);

        assert!(table_exists(conn, "frontmatter").await);
        assert!(index_exists(conn, "idx_frontmatter_key").await);

        assert!(table_exists(conn, "links").await);
        assert!(index_exists(conn, "idx_links_source").await);
        assert!(index_exists(conn, "idx_links_target").await);

        assert!(table_exists(conn, "tags").await);
        assert!(index_exists(conn, "idx_tags_path").await);

        assert!(table_exists(conn, "pending_rewrites").await);
        assert!(index_exists(conn, "idx_pending_target").await);
        assert!(index_exists(conn, "idx_pending_op").await);

        assert_eq!(
            scalar_i64(conn, "SELECT MAX(version) FROM schema_version").await,
            HIGHEST_KNOWN_VERSION
        );
        assert_eq!(
            scalar_i64(conn, "SELECT COUNT(*) FROM schema_version").await,
            1
        );
    }

    #[tokio::test]
    async fn reopen_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        {
            let _ = open_index(&path).await.expect("open #1");
        }
        let idx = open_index(&path).await.expect("open #2");
        let conn = idx.connection();

        assert_eq!(
            scalar_i64(conn, "SELECT MAX(version) FROM schema_version").await,
            HIGHEST_KNOWN_VERSION
        );
        assert_eq!(
            scalar_i64(conn, "SELECT COUNT(*) FROM schema_version").await,
            1
        );
    }

    #[tokio::test]
    async fn schema_too_new_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        {
            let _ = open_index(&path).await.expect("initial open");
        }
        let future_version = HIGHEST_KNOWN_VERSION + 1;
        {
            let db = Builder::new_local(&path).build().await.expect("builder");
            let conn = db.connect().expect("connect");
            conn.execute("DELETE FROM schema_version", ())
                .await
                .expect("delete");
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [future_version],
            )
            .await
            .expect("insert");
        }

        let err = open_index(&path).await.expect_err("should reject");
        match err {
            IndexError::SchemaTooNew(v) => assert_eq!(i64::from(v), future_version),
            other => panic!("expected SchemaTooNew, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn broken_migration_rolls_back_and_leaves_version_unchanged() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        {
            let _ = open_index(&path).await.expect("initial open");
        }

        let mut migrations: Vec<Migration> = MIGRATIONS.to_vec();
        let next_version = u32::try_from(HIGHEST_KNOWN_VERSION + 1).unwrap();
        migrations.push(Migration {
            version: next_version,
            up: "CREATE TABLE not_a_real_table (this is not valid sql);",
        });

        let err = open_index_with_migrations(&path, &migrations)
            .await
            .expect_err("broken migration should fail");
        assert!(matches!(err, IndexError::LibSql(_)), "got {err:?}");

        let idx = open_index(&path).await.expect("reopen after rollback");
        let conn = idx.connection();
        assert_eq!(
            scalar_i64(conn, "SELECT MAX(version) FROM schema_version").await,
            HIGHEST_KNOWN_VERSION,
            "schema_version must stay unchanged after a rolled-back migration"
        );
        assert!(
            !table_exists(conn, "not_a_real_table").await,
            "no broken-migration side effects should be visible after rollback"
        );
    }

    #[tokio::test]
    async fn v2_applies_on_top_of_existing_v1_database() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        let v1_only: &[Migration] = &[MIGRATIONS[0]];
        {
            let idx = open_index_with_migrations(&path, v1_only)
                .await
                .expect("v1 open");
            let conn = idx.connection();
            conn.execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES ('a.md', 'markdown', 1, 0, 'h', NULL, 0, 0, 0)",
                (),
            )
            .await
            .expect("insert seed file");
        }

        let idx = open_index(&path).await.expect("reopen with v2");
        let conn = idx.connection();

        assert_eq!(
            scalar_i64(conn, "SELECT COUNT(*) FROM files WHERE path = 'a.md'").await,
            1
        );
        assert!(table_exists(conn, "frontmatter").await);
        assert_eq!(
            scalar_i64(conn, "SELECT MAX(version) FROM schema_version").await,
            HIGHEST_KNOWN_VERSION
        );
    }

    #[tokio::test]
    async fn v6_applies_on_top_of_existing_v5_database() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        let v5_only: &[Migration] = &MIGRATIONS[..5];
        {
            let idx = open_index_with_migrations(&path, v5_only)
                .await
                .expect("v5 open");
            let conn = idx.connection();
            conn.execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES ('a.md', 'markdown', 1, 0, 'h', NULL, 0, 0, 0)",
                (),
            )
            .await
            .expect("insert seed file");
            conn.execute(
                "INSERT INTO blocks (file_path, block_id, position_hint, last_modified) \
                 VALUES ('a.md', 'seed', 0, 0)",
                (),
            )
            .await
            .expect("insert seed block");
        }

        let idx = open_index(&path).await.expect("reopen with v6");
        let conn = idx.connection();

        assert_eq!(
            scalar_i64(
                conn,
                "SELECT COUNT(*) FROM blocks WHERE file_path = 'a.md' AND block_id = 'seed'"
            )
            .await,
            1
        );
        assert!(table_exists(conn, "pending_rewrites").await);
        assert!(index_exists(conn, "idx_pending_target").await);
        assert!(index_exists(conn, "idx_pending_op").await);
        assert_eq!(
            scalar_i64(conn, "SELECT MAX(version) FROM schema_version").await,
            HIGHEST_KNOWN_VERSION
        );
    }

    #[tokio::test]
    async fn foreign_keys_pragma_is_on_after_open() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);
        let idx = open_index(&path).await.expect("open");
        let conn = idx.connection();

        let mut rows = conn.query("PRAGMA foreign_keys", ()).await.expect("query");
        let row = rows.next().await.expect("next").expect("row");
        let v: i64 = row.get(0).expect("get");
        assert_eq!(v, 1, "foreign_keys must be ON after open_index");
    }
}
