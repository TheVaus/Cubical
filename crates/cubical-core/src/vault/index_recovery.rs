use std::path::{Path, PathBuf};

use cubical_index::{append_audit, open_index, AuditLevel, IndexConn, IndexError};

use super::rename_journal;
use crate::time::unix_now_secs;

pub const INDEX_REBUILT: &str = "index_rebuilt";

pub const SEARCH_REBUILT: &str = "search_rebuilt";

const QUARANTINE_SUFFIX: &str = ".corrupt";

const SIDECAR_SUFFIXES: [&str; 2] = ["-wal", "-shm"];

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[must_use]
pub fn quarantine_path(db_path: &Path) -> PathBuf {
    sidecar(db_path, QUARANTINE_SUFFIX)
}

fn quarantine(db_path: &Path) -> std::io::Result<PathBuf> {
    let target = quarantine_path(db_path);
    std::fs::rename(db_path, &target)?;
    for suffix in SIDECAR_SUFFIXES {
        let from = sidecar(db_path, suffix);
        if !from.exists() {
            continue;
        }
        let to = sidecar(&target, suffix);
        if let Err(e) = std::fs::rename(&from, &to) {
            tracing::warn!(
                from = %from.display(),
                error = %e,
                "could not move a corrupt index sidecar aside; SQLite will discard it",
            );
        }
    }
    Ok(target)
}

pub(crate) async fn open_index_recovering(
    vault_root: &Path,
    db_path: &Path,
) -> Result<IndexConn, IndexError> {
    let failure = match open_index(db_path).await {
        Ok(conn) => return Ok(conn),
        Err(e) => e,
    };

    if !failure.is_unusable_database() {
        return Err(failure);
    }

    let journal = match rename_journal::read_journal(vault_root) {
        Ok(read) if read.is_intact() => read,
        Ok(read) => {
            tracing::error!(
                db = %db_path.display(),
                malformed_lines = read.malformed_lines,
                "index database is unreadable and the rename journal is damaged; refusing to rebuild",
            );
            return Err(failure);
        }
        Err(e) => {
            tracing::error!(
                db = %db_path.display(),
                error = %e,
                "index database is unreadable and the rename journal could not be read; refusing to rebuild",
            );
            return Err(failure);
        }
    };

    tracing::error!(
        db = %db_path.display(),
        error = %failure,
        journal_entries = journal.entries.len(),
        "index database is unreadable; moving it aside and rebuilding from the vault",
    );

    let quarantined = quarantine(db_path).map_err(|source| IndexError::Io {
        path: db_path.to_path_buf(),
        source,
    })?;

    let conn = open_index(db_path).await?;

    let detail = serde_json::json!({
        "error": failure.to_string(),
        "quarantined": quarantined.display().to_string(),
        "journal_entries": journal.entries.len(),
    })
    .to_string();

    if let Err(e) = append_audit(
        &conn,
        AuditLevel::Warn,
        INDEX_REBUILT,
        "index database was unreadable; it was moved aside and is being rebuilt by the vault scan",
        &detail,
        unix_now_secs(),
    )
    .await
    {
        tracing::warn!(error = %e, "index-rebuild audit insert failed");
    }

    Ok(conn)
}

pub(crate) async fn record_search_rebuild(conn: &IndexConn, search_dir: &Path, reason: &str) {
    let detail = serde_json::json!({
        "dir": search_dir.display().to_string(),
        "reason": reason,
    })
    .to_string();
    if let Err(e) = append_audit(
        conn,
        AuditLevel::Warn,
        SEARCH_REBUILT,
        "search index was unusable; it was wiped and is being rebuilt by the vault scan",
        &detail,
        unix_now_secs(),
    )
    .await
    {
        tracing::warn!(error = %e, "search-rebuild audit insert failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_index::pending_count_total;

    fn corrupt(path: &Path) {
        std::fs::write(path, b"not a database, just bytes").unwrap();
    }

    async fn audit_categories(conn: &IndexConn) -> Vec<String> {
        let mut rows = conn
            .connection()
            .query("SELECT category FROM audit_log ORDER BY id", ())
            .await
            .expect("query");
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.expect("next") {
            out.push(row.get::<String>(0).expect("get"));
        }
        out
    }

    fn journal_entry(op_id: i64, from: &str, to: &str) -> rename_journal::RenameJournalEntry {
        rename_journal::RenameJournalEntry {
            op_id,
            kind: "file".into(),
            from: from.into(),
            to: to.into(),
            at: 1_750_000_000,
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        db: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".cubical")).unwrap();
        let db = root.join(".cubical").join("index.db");
        Fixture {
            _dir: dir,
            root,
            db,
        }
    }

    #[tokio::test]
    async fn healthy_index_opens_untouched() {
        let f = fixture();
        {
            let conn = open_index_recovering(&f.root, &f.db).await.expect("open");
            assert_eq!(pending_count_total(&conn).await.unwrap(), 0);
        }
        let conn = open_index_recovering(&f.root, &f.db).await.expect("reopen");
        assert!(audit_categories(&conn).await.is_empty());
        assert!(!quarantine_path(&f.db).exists());
    }

    #[tokio::test]
    async fn corrupt_index_is_moved_aside_and_rebuilt() {
        let f = fixture();
        corrupt(&f.db);

        let conn = open_index_recovering(&f.root, &f.db)
            .await
            .expect("corrupt index recovers");

        assert_eq!(pending_count_total(&conn).await.unwrap(), 0);
        assert_eq!(audit_categories(&conn).await, vec![INDEX_REBUILT]);

        let aside = quarantine_path(&f.db);
        assert!(aside.exists(), "the corrupt file is preserved, not deleted");
        assert_eq!(
            std::fs::read(&aside).unwrap(),
            b"not a database, just bytes"
        );
    }

    #[tokio::test]
    async fn rebuild_preserves_the_rename_journal() {
        let f = fixture();
        rename_journal::append_entry(&f.root, &journal_entry(1, "a.md", "b.md")).unwrap();
        corrupt(&f.db);

        let _conn = open_index_recovering(&f.root, &f.db)
            .await
            .expect("recovers");

        let after = rename_journal::read_journal(&f.root).unwrap();
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.entries[0].from, "a.md");
    }

    #[tokio::test]
    async fn damaged_journal_fails_closed_without_wiping() {
        let f = fixture();
        let journal = rename_journal::journal_path(&f.root);
        std::fs::write(&journal, "{\"op_id\": 1, truncated\n").unwrap();
        corrupt(&f.db);

        let err = open_index_recovering(&f.root, &f.db)
            .await
            .expect_err("a damaged journal must block the rebuild");
        assert!(err.is_unusable_database(), "got {err:?}");
        assert!(!quarantine_path(&f.db).exists());
        assert_eq!(
            std::fs::read(&f.db).unwrap(),
            b"not a database, just bytes",
            "the corrupt index is left exactly where it was"
        );
        assert!(journal.exists());
    }

    #[tokio::test]
    async fn unreadable_journal_fails_closed_without_wiping() {
        let f = fixture();
        let journal = rename_journal::journal_path(&f.root);
        std::fs::create_dir_all(&journal).unwrap();
        corrupt(&f.db);

        let err = open_index_recovering(&f.root, &f.db)
            .await
            .expect_err("an unreadable journal must block the rebuild");
        assert!(err.is_unusable_database(), "got {err:?}");
        assert!(!quarantine_path(&f.db).exists());
        assert!(f.db.exists());
    }

    #[tokio::test]
    async fn schema_too_new_stays_terminal() {
        let f = fixture();
        {
            let conn = open_index(&f.db).await.expect("fresh");
            conn.connection()
                .execute("DELETE FROM schema_version", ())
                .await
                .unwrap();
            conn.connection()
                .execute("INSERT INTO schema_version (version) VALUES (9999)", ())
                .await
                .unwrap();
        }

        let err = open_index_recovering(&f.root, &f.db)
            .await
            .expect_err("a newer schema must not be wiped");
        assert!(matches!(err, IndexError::SchemaTooNew(9999)), "got {err:?}");
        assert!(!quarantine_path(&f.db).exists());
        assert!(f.db.exists());
    }

    #[tokio::test]
    async fn stale_sidecars_do_not_survive_the_rebuild() {
        let f = fixture();
        corrupt(&f.db);
        std::fs::write(sidecar(&f.db, "-wal"), b"stale wal").unwrap();
        std::fs::write(sidecar(&f.db, "-shm"), b"stale shm").unwrap();

        let _conn = open_index_recovering(&f.root, &f.db)
            .await
            .expect("recovers");

        for suffix in SIDECAR_SUFFIXES {
            let next_to_fresh = sidecar(&f.db, suffix);
            let stale = std::fs::read(&next_to_fresh).unwrap_or_default();
            assert!(
                !stale.starts_with(b"stale"),
                "{} must not survive next to the rebuilt database",
                next_to_fresh.display()
            );
        }
    }
}
