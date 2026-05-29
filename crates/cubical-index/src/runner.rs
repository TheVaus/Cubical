//! The migration runner and the [`IndexConn`] handle.
//!
//! [`open_index`] is the only entry point callers need. It opens (or
//! creates) the libSQL database at the supplied path, runs every
//! pending migration inside a single transaction, and returns a handle
//! holding the live connection.
//!
//! Migration application is **atomic**: every pending migration's SQL is
//! executed inside one transaction together with the `schema_version`
//! bump. If any statement fails, the transaction is rolled back and the
//! on-disk state — including `schema_version` — is unchanged.

use std::path::Path;

use libsql::{Builder, Connection, Database};

use crate::error::IndexError;
use crate::migrations::{Migration, MIGRATIONS};

/// An open handle to the on-disk index database.
///
/// Holds the libSQL [`Database`] alongside its connection so the database
/// stays alive for as long as the connection is in use. Drop the
/// [`IndexConn`] to release both.
pub struct IndexConn {
    // The Database must outlive any connection it produced. Held here so
    // dropping `IndexConn` releases everything in the right order.
    _db: Database,
    conn: Connection,
}

impl IndexConn {
    /// Borrow the underlying libSQL connection for queries.
    ///
    /// Higher-level query helpers will land alongside vault scanning in
    /// a later session; for now callers go through the raw connection.
    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

impl std::fmt::Debug for IndexConn {
    // libSQL's `Connection` doesn't implement `Debug`, so we can't derive
    // it. The handle has no user-visible state worth printing — its
    // identity is its open file — so a minimal placeholder is enough.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexConn").finish_non_exhaustive()
    }
}

/// Open (or create) the index database at `path` and bring its schema
/// up to date.
///
/// On a fresh path this creates the database file and applies every
/// migration in [`MIGRATIONS`]. On an existing database it applies any
/// migrations newer than the on-disk `schema_version`. If the on-disk
/// version is *higher* than this build's highest known migration, returns
/// [`IndexError::SchemaTooNew`] without touching the file.
///
/// The call is idempotent: invoking it twice on the same path is a no-op
/// the second time.
///
/// The parent directory of `path` must already exist; this function does
/// not create directories. (Vault setup is the caller's job.)
pub async fn open_index(path: &Path) -> Result<IndexConn, IndexError> {
    open_index_with_migrations(path, MIGRATIONS).await
}

/// Inner entry point taking an explicit migrations slice.
///
/// Exposed at `pub(crate)` so unit tests can drive the runner with
/// synthetic migrations (e.g. a deliberately broken migration to prove
/// that the transaction wrap actually rolls back).
pub(crate) async fn open_index_with_migrations(
    path: &Path,
    migrations: &[Migration],
) -> Result<IndexConn, IndexError> {
    let db = Builder::new_local(path).build().await?;
    let conn = db.connect()?;

    // Foreign-key enforcement is OFF by default in libSQL/SQLite —
    // the pragma is per-connection. Cubical relies on it for the
    // `frontmatter.file_path` cascade (introduced in v2) and for any
    // future cascade rules; turn it on before migrations so
    // schema-level constraints behave as documented.
    conn.execute("PRAGMA foreign_keys = ON", ()).await?;

    run_migrations(&conn, migrations).await?;

    Ok(IndexConn { _db: db, conn })
}

/// Apply every pending migration to `conn`.
///
/// Reads the current `schema_version` (treating a missing table as 0),
/// rejects an on-disk version higher than the highest known migration,
/// and otherwise runs every migration with `version > current` inside a
/// single transaction together with the version bump.
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

    // Migrations slice is the source of truth for ordering. Sort defensively
    // so a typo in the slice ordering can't silently corrupt the database.
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
    // schema_version is a single-row, high-water-mark table. Reset and
    // write the new version inside the same transaction so the bump is
    // atomic with the schema changes above.
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

/// Read the current schema version from the database.
///
/// Returns `0` if the `schema_version` table doesn't exist yet (fresh
/// database) or if it exists but has no rows (shouldn't happen in
/// practice, but treat it the same as fresh rather than panicking).
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
    // MAX() over an empty table returns NULL; map that to 0.
    let v: Option<i64> = row.get(0)?;
    Ok(v.unwrap_or(0).try_into().unwrap_or(u32::MAX))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn db_path(dir: &TempDir) -> PathBuf {
        dir.path().join("index.db")
    }

    /// Count rows returned by a single-column COUNT query.
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

    /// The version the highest-numbered known migration applies. Use
    /// this rather than hard-coding so adding a new migration only
    /// requires updating the `MIGRATIONS` slice — not every test.
    const HIGHEST_KNOWN_VERSION: i64 = 5;

    #[tokio::test]
    async fn fresh_db_applies_all_known_migrations() {
        let dir = TempDir::new().unwrap();
        let path = db_path(&dir);

        let idx = open_index(&path).await.expect("open");

        let conn = idx.connection();
        // All four L0 tables exist.
        assert!(table_exists(conn, "schema_version").await);
        assert!(table_exists(conn, "files").await);
        assert!(table_exists(conn, "config").await);
        assert!(table_exists(conn, "audit_log").await);

        // All three L0 indexes exist.
        assert!(index_exists(conn, "idx_files_type").await);
        assert!(index_exists(conn, "idx_files_inode").await);
        assert!(index_exists(conn, "idx_audit_timestamp").await);

        // L1's frontmatter table + index exist.
        assert!(table_exists(conn, "frontmatter").await);
        assert!(index_exists(conn, "idx_frontmatter_key").await);

        // L3's links table + indexes exist.
        assert!(table_exists(conn, "links").await);
        assert!(index_exists(conn, "idx_links_source").await);
        assert!(index_exists(conn, "idx_links_target").await);

        // L3 Session D's tags table + index exist.
        assert!(table_exists(conn, "tags").await);
        assert!(index_exists(conn, "idx_tags_path").await);

        // schema_version == HIGHEST_KNOWN_VERSION, single row.
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

        // First open: applies all migrations.
        {
            let _ = open_index(&path).await.expect("open #1");
        }
        // Second open: should be a no-op — no errors, no schema change,
        // no duplicate rows in schema_version.
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

        // Bring the DB up to the current version the normal way.
        {
            let _ = open_index(&path).await.expect("initial open");
        }
        // Then manually bump schema_version to a value beyond the
        // current set of migrations to simulate a vault touched by a
        // future build of Cubical.
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

        // Bring the DB up to the current version cleanly.
        {
            let _ = open_index(&path).await.expect("initial open");
        }

        // Stitch together the real migrations + a broken trailing one.
        // Only the broken one will run (existing ones are already
        // applied), and its SQL is invalid — so the transaction
        // should roll back, leaving schema_version unchanged and no
        // side effects on disk.
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

        // Reopen with the real (valid) migrations slice and verify
        // nothing from the failed migration leaked in.
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
        // Bring the DB up to v1 only, with data in `files`, then
        // re-open with the full migrations slice and verify the data
        // survives and the new table is in place.
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

        // Now apply the full set including v2.
        let idx = open_index(&path).await.expect("reopen with v2");
        let conn = idx.connection();

        // Seed data survived.
        assert_eq!(
            scalar_i64(conn, "SELECT COUNT(*) FROM files WHERE path = 'a.md'").await,
            1
        );
        // v2 table exists.
        assert!(table_exists(conn, "frontmatter").await);
        // schema_version reflects v2.
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
