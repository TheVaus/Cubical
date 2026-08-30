use libsql::{params, Connection};

use crate::error::IndexError;
use crate::runner::IndexConn;

pub const AUDIT_LOG_MAX_ROWS: i64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditLevel {
    Info,
    Warn,
}

impl AuditLevel {
    fn as_str(self) -> &'static str {
        match self {
            AuditLevel::Info => "info",
            AuditLevel::Warn => "warn",
        }
    }
}

pub async fn append_audit(
    conn: &IndexConn,
    level: AuditLevel,
    category: &str,
    message: &str,
    detail: &str,
    now: i64,
) -> Result<(), IndexError> {
    conn.connection()
        .execute(
            "INSERT INTO audit_log (timestamp, level, category, message, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now, level.as_str(), category, message, detail],
        )
        .await?;
    Ok(())
}

pub async fn prune_audit_log(conn: &IndexConn, max_rows: i64) -> Result<u64, IndexError> {
    prune_audit_log_conn(conn.connection(), max_rows).await
}

pub(crate) async fn prune_audit_log_conn(
    conn: &Connection,
    max_rows: i64,
) -> Result<u64, IndexError> {
    if max_rows <= 0 {
        return Ok(0);
    }

    // O(1) guard: ids increase, so a span <= max_rows cannot hold more than max_rows rows.
    let mut rows = conn
        .query("SELECT MIN(id), MAX(id) FROM audit_log", ())
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(0);
    };
    let (Some(min), Some(max)) = (row.get::<Option<i64>>(0)?, row.get::<Option<i64>>(1)?) else {
        return Ok(0);
    };
    if max - min < max_rows {
        return Ok(0);
    }

    let deleted = conn
        .execute(
            "DELETE FROM audit_log WHERE id < (
                 SELECT MIN(id) FROM (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?1)
             )",
            params![max_rows],
        )
        .await?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::TempDir;

    async fn seed(conn: &IndexConn, n: i64) {
        for i in 0..n {
            conn.connection()
                .execute(
                    "INSERT INTO audit_log (timestamp, level, category, message, detail)
                     VALUES (?1, 'info', 'test', ?2, NULL)",
                    params![i, format!("row {i}")],
                )
                .await
                .unwrap();
        }
    }

    async fn count(conn: &IndexConn) -> i64 {
        let mut rows = conn
            .connection()
            .query("SELECT COUNT(*) FROM audit_log", ())
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    }

    #[tokio::test]
    async fn prune_is_a_noop_under_the_cap() {
        let dir = TempDir::new().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        seed(&conn, 10).await;

        assert_eq!(prune_audit_log(&conn, 100).await.unwrap(), 0);
        assert_eq!(count(&conn).await, 10);
    }

    #[tokio::test]
    async fn prune_keeps_only_the_newest_rows() {
        let dir = TempDir::new().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        seed(&conn, 50).await;

        let deleted = prune_audit_log(&conn, 20).await.unwrap();
        assert_eq!(deleted, 30);
        assert_eq!(count(&conn).await, 20);

        // the survivors are the most recent ones
        let mut rows = conn
            .connection()
            .query("SELECT MIN(timestamp), MAX(timestamp) FROM audit_log", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(row.get::<i64>(0).unwrap(), 30);
        assert_eq!(row.get::<i64>(1).unwrap(), 49);
    }

    #[tokio::test]
    async fn prune_handles_an_empty_table() {
        let dir = TempDir::new().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();

        assert_eq!(prune_audit_log(&conn, 10).await.unwrap(), 0);
        assert_eq!(count(&conn).await, 0);
    }
}

#[cfg(test)]
mod append_tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::tempdir;

    #[tokio::test]
    async fn append_writes_the_level_as_text() {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();

        append_audit(&conn, AuditLevel::Warn, "watcher_unavailable", "m", "{}", 7)
            .await
            .unwrap();

        let mut rows = conn
            .connection()
            .query(
                "SELECT level, category, message, detail, timestamp FROM audit_log",
                (),
            )
            .await
            .unwrap();
        let r = rows.next().await.unwrap().unwrap();
        assert_eq!(r.get::<String>(0).unwrap(), "warn");
        assert_eq!(r.get::<String>(1).unwrap(), "watcher_unavailable");
        assert_eq!(r.get::<String>(2).unwrap(), "m");
        assert_eq!(r.get::<String>(3).unwrap(), "{}");
        assert_eq!(r.get::<i64>(4).unwrap(), 7);
    }
}
