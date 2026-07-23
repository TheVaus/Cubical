use cubical_index::IndexConn;
use libsql::{params_from_iter, Value as SqlValue};
use serde::Serialize;

use crate::ast::{Command, Query};
use crate::error::QueryError;
use crate::plan::{plan, SqlParam};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteRef {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub note: NoteRef,
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryResult {
    List {
        notes: Vec<NoteRef>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Row>,
    },
    Count {
        count: usize,
    },
}

fn title_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

fn to_sql_values(params: &[SqlParam]) -> Vec<SqlValue> {
    params
        .iter()
        .map(|p| match p {
            SqlParam::Text(s) => SqlValue::Text(s.clone()),
            SqlParam::Real(f) => SqlValue::Real(*f),
            SqlParam::Int(i) => SqlValue::Integer(*i),
        })
        .collect()
}

fn cell_text(v: &SqlValue) -> String {
    match v {
        SqlValue::Null => String::new(),
        SqlValue::Integer(i) => i.to_string(),
        SqlValue::Real(f) => f.to_string(),
        SqlValue::Text(s) => s.clone(),
        SqlValue::Blob(_) => String::new(),
    }
}

pub async fn run(conn: &IndexConn, q: &Query) -> Result<QueryResult, QueryError> {
    let p = plan(q);
    let values = to_sql_values(&p.params);
    let c = conn.connection();

    match &q.command {
        Command::Count => {
            let mut rows = c.query(&p.sql, params_from_iter(values)).await?;
            let count = match rows.next().await? {
                Some(row) => usize::try_from(row.get::<i64>(0)?).unwrap_or(0),
                None => 0,
            };
            Ok(QueryResult::Count { count })
        }
        Command::List => {
            let mut rows = c.query(&p.sql, params_from_iter(values)).await?;
            let mut notes = Vec::new();
            while let Some(row) = rows.next().await? {
                let path: String = row.get(0)?;
                let title = title_of(&path);
                notes.push(NoteRef { path, title });
            }
            Ok(QueryResult::List { notes })
        }
        Command::Table(cols) => {
            let mut rows = c.query(&p.sql, params_from_iter(values)).await?;
            let mut out = Vec::new();
            while let Some(row) = rows.next().await? {
                let path: String = row.get(0)?;
                let note = NoteRef {
                    title: title_of(&path),
                    path,
                };
                let mut cells = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    let v = row.get_value(i32::try_from(i + 1).unwrap_or(0))?;
                    cells.push(cell_text(&v));
                }
                out.push(Row { note, cells });
            }
            Ok(QueryResult::Table {
                columns: cols.clone(),
                rows: out,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;
    use cubical_index::open_index;
    use tempfile::tempdir;

    async fn seed() -> (tempfile::TempDir, IndexConn) {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        let c = conn.connection();
        for (path, status, prio) in [
            ("a.md", "\"in-progress\"", "3"),
            ("b.md", "\"done\"", "1"),
            ("c.md", "\"in-progress\"", "2"),
        ] {
            c.execute(
                "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
                 inode, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![path],
            )
            .await
            .unwrap();
            c.execute(
                "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, 'status', ?2)",
                libsql::params![path, status],
            )
            .await
            .unwrap();
            c.execute(
                "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, 'priority', ?2)",
                libsql::params![path, prio],
            )
            .await
            .unwrap();
        }
        (dir, conn)
    }

    #[tokio::test]
    async fn list_all() {
        let (_d, conn) = seed().await;
        let r = run(&conn, &parse("LIST").unwrap()).await.unwrap();
        match r {
            QueryResult::List { notes } => {
                let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
                assert_eq!(paths, vec!["a.md", "b.md", "c.md"]);
                assert_eq!(notes[0].title, "a");
            }
            _ => panic!("expected list"),
        }
    }

    #[tokio::test]
    async fn count_with_where() {
        let (_d, conn) = seed().await;
        let q = parse(r#"COUNT WHERE status = "in-progress""#).unwrap();
        match run(&conn, &q).await.unwrap() {
            QueryResult::Count { count } => assert_eq!(count, 2),
            _ => panic!("expected count"),
        }
    }

    #[tokio::test]
    async fn numeric_comparison_is_numeric_not_lexical() {
        let (_d, conn) = seed().await;
        let q = parse("LIST WHERE priority >= 2 SORT priority DESC").unwrap();
        match run(&conn, &q).await.unwrap() {
            QueryResult::List { notes } => {
                let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
                assert_eq!(paths, vec!["a.md", "c.md"]);
            }
            _ => panic!("expected list"),
        }
    }

    #[tokio::test]
    async fn table_projects_cells_and_empty_for_missing_key() {
        let (_d, conn) = seed().await;
        let q = parse("TABLE status, note").unwrap();
        match run(&conn, &q).await.unwrap() {
            QueryResult::Table { columns, rows } => {
                assert_eq!(columns, vec!["status".to_string(), "note".to_string()]);
                assert_eq!(rows[0].note.path, "a.md");
                assert_eq!(
                    rows[0].cells,
                    vec!["in-progress".to_string(), String::new()]
                );
            }
            _ => panic!("expected table"),
        }
    }

    #[tokio::test]
    async fn from_folder_restricts_paths() {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        let c = conn.connection();
        for path in ["areas/x.md", "areas/sub/y.md", "other/z.md"] {
            c.execute(
                "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
                 inode, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![path],
            )
            .await
            .unwrap();
        }
        let q = parse(r#"LIST FROM "areas""#).unwrap();
        match run(&conn, &q).await.unwrap() {
            QueryResult::List { notes } => {
                let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
                assert_eq!(paths, vec!["areas/sub/y.md", "areas/x.md"]);
            }
            _ => panic!("expected list"),
        }
    }
}
