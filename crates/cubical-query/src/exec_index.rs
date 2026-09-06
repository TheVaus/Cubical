use cubical_ast::note_title;
use cubical_index::IndexConn;
use libsql::{params_from_iter, Value as SqlValue};

use crate::ast::{Command, Query};
use crate::error::QueryError;
use crate::exec::{ListItem, NoteRef, QueryResult, Row};
use crate::plan::{plan, SqlParam};

pub const NOTE_ROW_LABEL: &str = "File";

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

fn note_ref(path: String) -> NoteRef {
    NoteRef {
        title: note_title(&path).to_string(),
        path,
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
            let mut items = Vec::new();
            while let Some(row) = rows.next().await? {
                let note = note_ref(row.get(0)?);
                items.push(ListItem {
                    text: note.title.clone(),
                    note: Some(note),
                });
            }
            Ok(QueryResult::List { items })
        }
        Command::Table(cols) => {
            let mut rows = c.query(&p.sql, params_from_iter(values)).await?;
            let mut out = Vec::new();
            while let Some(row) = rows.next().await? {
                let note = note_ref(row.get(0)?);
                let mut cells = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    let v = row.get_value(i32::try_from(i + 1).unwrap_or(0))?;
                    cells.push(cell_text(&v));
                }
                out.push(Row {
                    note: Some(note),
                    cells,
                });
            }
            Ok(QueryResult::Table {
                columns: cols.clone(),
                rows: out,
                row_label: Some(NOTE_ROW_LABEL.to_string()),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::Relation;
    use crate::parse;
    use cubical_index::open_index;
    use tempfile::tempdir;

    async fn seed_paths(paths: &[&str]) -> (tempfile::TempDir, IndexConn) {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        let c = conn.connection();
        for path in paths {
            c.execute(
                "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
                 inode, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![*path],
            )
            .await
            .unwrap();
        }
        (dir, conn)
    }

    async fn list_paths(conn: &IndexConn, source: &str) -> Vec<String> {
        let q = parse(source).unwrap();
        match crate::exec::run(Relation::Index(conn), &q).await.unwrap() {
            crate::exec::QueryResult::List { items } => items
                .into_iter()
                .filter_map(|i| i.note.map(|n| n.path))
                .collect(),
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn from_a_path_restricts_to_that_folder() {
        let (_d, conn) = seed_paths(&["areas/x.md", "areas/sub/y.md", "other/z.md"]).await;
        assert_eq!(
            list_paths(&conn, r#"LIST FROM "areas""#).await,
            vec!["areas/sub/y.md", "areas/x.md"]
        );
    }

    #[tokio::test]
    async fn list_items_carry_a_note_reference() {
        let (_d, conn) = seed_paths(&["alpha.md"]).await;
        let q = parse("LIST").unwrap();
        match crate::exec::run(Relation::Index(&conn), &q).await.unwrap() {
            crate::exec::QueryResult::List { items } => {
                assert_eq!(items[0].text, "alpha");
                let note = items[0].note.as_ref().expect("a note query links its rows");
                assert_eq!(note.path, "alpha.md");
                assert_eq!(note.title, "alpha");
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_note_table_labels_its_leading_column() {
        let (_d, conn) = seed_paths(&["alpha.md"]).await;
        let q = parse("TABLE status").unwrap();
        match crate::exec::run(Relation::Index(&conn), &q).await.unwrap() {
            crate::exec::QueryResult::Table {
                row_label, rows, ..
            } => {
                assert_eq!(row_label.as_deref(), Some(NOTE_ROW_LABEL));
                assert!(rows[0].note.is_some());
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }
}
