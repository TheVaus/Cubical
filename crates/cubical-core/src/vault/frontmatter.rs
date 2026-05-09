//! Refresh the `frontmatter` index rows for a single markdown file.
//!
//! Both write paths — initial scan and the file watcher — call this
//! helper after the matching `files` UPSERT. The strategy is
//! "delete-then-insert" keyed on `file_path`: idempotent across
//! re-scans, naturally drops keys the user removed, and avoids any
//! diff-tracking bookkeeping.
//!
//! Failures are logged and swallowed at the caller — a malformed
//! frontmatter file or a transient I/O error must not abort the
//! whole scan or take the watcher down. This mirrors `scan.rs`'s
//! existing per-file resilience policy.
//!
//! Called via `tokio::task::spawn_blocking` for the parse step
//! because `pulldown-cmark` is CPU-bound; the DB writes happen on
//! the async runtime as usual.

use std::path::Path;

use cubical_ast::{parse, Frontmatter};
use libsql::params;

use crate::vault::Vault;

/// Read `abs_path`, parse its markdown, and replace the file's rows
/// in the `frontmatter` table with whatever the parsed
/// [`Frontmatter`] contains.
///
/// `rel_path_str` is the path key used in `files.path` and
/// `frontmatter.file_path`. It is the caller's responsibility to
/// make sure the matching `files` row exists *before* this is
/// invoked, so the foreign-key cascade has a parent to point at.
///
/// Returns `Ok(rows_inserted)` on success. Returns the underlying
/// libSQL error if the SQL fails; I/O errors and parse warnings are
/// logged and counted as zero rows.
pub async fn refresh_frontmatter(
    vault: &Vault,
    abs_path: &Path,
    rel_path_str: &str,
) -> Result<u32, libsql::Error> {
    let parsed = match parse_off_executor(abs_path).await {
        Some(fm) => fm,
        None => {
            // No frontmatter, malformed YAML, or unreadable file —
            // wipe any stale rows and we're done.
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
        // Values are stored as their JSON representation — scalars,
        // lists, and nested mappings all round-trip through one
        // column shape. `to_string` is infallible for owned values.
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

/// Read + parse the file off the runtime. Returns `None` if the file
/// can't be read, has no frontmatter, or has malformed YAML — every
/// failure is logged at `debug` / `warn` and treated as "no
/// frontmatter to record."
async fn parse_off_executor(abs_path: &Path) -> Option<Frontmatter> {
    let path_buf = abs_path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let bytes = match std::fs::read(&path_buf) {
            Ok(b) => b,
            Err(e) => {
                tracing::debug!(path = %path_buf.display(), error = %e, "frontmatter: read failed");
                return None;
            }
        };
        // Markdown is canonically UTF-8. Use lossy conversion so a
        // file with a few stray non-UTF-8 bytes still gets its
        // frontmatter parsed rather than being silently skipped.
        let source = String::from_utf8_lossy(&bytes).into_owned();
        let doc = parse(&source);
        doc.frontmatter
    })
    .await;
    match result {
        Ok(fm) => fm,
        Err(join_err) => {
            tracing::warn!(path = %abs_path.display(), error = %join_err, "frontmatter: parse task join failed");
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

    /// `files` UPSERT helper for the test fixtures — refresh
    /// requires the parent row to exist for the cascade to attach.
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
        std::fs::write(
            &p,
            "---\ntitle: Hello\ntags: [a, b]\ncount: 3\n---\n\nbody\n",
        )
        .unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        let n = refresh_frontmatter(&vault, &p, "note.md")
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
        std::fs::write(&p, "---\ntitle: A\nstatus: draft\n---\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        refresh_frontmatter(&vault, &p, "note.md")
            .await
            .expect("first");

        // User deletes `status` and renames `title`.
        std::fs::write(&p, "---\nheading: B\n---\n").unwrap();
        refresh_frontmatter(&vault, &p, "note.md")
            .await
            .expect("second");

        let conn = vault.index().connection();
        assert_eq!(
            count_rows(conn, "SELECT COUNT(*) FROM frontmatter").await,
            1
        );
        // Only `heading` remains.
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
        std::fs::write(&p, "---\ntitle: : :\n  - bad\n---\n\nbody\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        let n = refresh_frontmatter(&vault, &p, "note.md")
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
        std::fs::write(&p, "# Just a heading\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        seed_files_row(&vault, "note.md").await;

        let n = refresh_frontmatter(&vault, &p, "note.md")
            .await
            .expect("refresh");
        assert_eq!(n, 0);
    }
}
