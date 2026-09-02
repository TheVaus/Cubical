use cubical_index::{open_index, IndexConn};
use cubical_table::{Cell, Table};

use crate::exec::{QueryResult, Relation};
use crate::parse;

#[derive(Clone, Copy)]
enum V {
    Str(&'static str),
    Num(f64),
    Bool(bool),
    Missing,
}

struct Fixture {
    columns: Vec<&'static str>,
    records: Vec<(&'static str, Vec<V>)>,
}

fn fixture() -> Fixture {
    Fixture {
        columns: vec!["id", "status", "priority", "done", "code"],
        records: vec![
            (
                "a",
                vec![
                    V::Str("in-progress"),
                    V::Num(3.0),
                    V::Bool(true),
                    V::Str("007"),
                ],
            ),
            (
                "b",
                vec![V::Str("done"), V::Num(1.0), V::Bool(false), V::Str("x1")],
            ),
            (
                "c",
                vec![V::Str("in-progress"), V::Num(2.0), V::Missing, V::Missing],
            ),
            (
                "d",
                vec![V::Missing, V::Missing, V::Missing, V::Str("zeta")],
            ),
        ],
    }
}

fn json_value(v: V) -> Option<String> {
    match v {
        V::Str(s) => Some(format!("\"{s}\"")),
        V::Num(n) => Some(format!("{n}")),
        V::Bool(b) => Some(b.to_string()),
        V::Missing => None,
    }
}

fn cell(v: V) -> Cell {
    match v {
        V::Str(s) => Cell {
            text: s.to_string(),
            num: None,
            boolean: None,
        },
        V::Num(n) => Cell {
            text: format_num(n),
            num: Some(n),
            boolean: None,
        },
        V::Bool(b) => Cell {
            text: b.to_string(),
            num: None,
            boolean: Some(b),
        },
        V::Missing => Cell {
            text: String::new(),
            num: None,
            boolean: None,
        },
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

async fn seeded_index(fx: &Fixture) -> (tempfile::TempDir, IndexConn) {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_index(&dir.path().join("index.db")).await.unwrap();
    let c = conn.connection();
    for (id, values) in &fx.records {
        let path = format!("{id}.md");
        c.execute(
            "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
             inode, last_seen, created_at, updated_at) \
             VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
            libsql::params![path.clone()],
        )
        .await
        .unwrap();
        for (key, value) in fx.columns[1..].iter().zip(values.iter()) {
            if let Some(json) = json_value(*value) {
                c.execute(
                    "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, ?2, ?3)",
                    libsql::params![path.clone(), (*key).to_string(), json],
                )
                .await
                .unwrap();
            }
        }
    }
    (dir, conn)
}

fn seeded_table(fx: &Fixture) -> Table {
    Table {
        columns: fx.columns.iter().map(|c| (*c).to_string()).collect(),
        rows: fx
            .records
            .iter()
            .map(|(id, values)| {
                let mut row = vec![cell(V::Str(id))];
                row.extend(values.iter().map(|v| cell(*v)));
                row
            })
            .collect(),
    }
}

#[derive(Debug, PartialEq)]
enum Normalized {
    List(Vec<String>),
    Table(Vec<String>, Vec<Vec<String>>),
    Count(usize),
}

fn normalize(result: QueryResult) -> Normalized {
    match result {
        QueryResult::List { items } => {
            Normalized::List(items.into_iter().map(|i| i.text).collect())
        }
        QueryResult::Table { columns, rows, .. } => {
            Normalized::Table(columns, rows.into_iter().map(|r| r.cells).collect())
        }
        QueryResult::Count { count } => Normalized::Count(count),
    }
}

async fn both(source: &str) -> (Normalized, Normalized) {
    let fx = fixture();
    let q = parse(source).unwrap_or_else(|e| panic!("parse `{source}`: {e}"));
    let (_dir, conn) = seeded_index(&fx).await;
    let table = seeded_table(&fx);
    let from_index = crate::exec::run(Relation::Index(&conn), &q).await.unwrap();
    let from_table = crate::exec::run(Relation::Table(&table), &q).await.unwrap();
    (normalize(from_index), normalize(from_table))
}

async fn agree(source: &str) -> Normalized {
    let (index, table) = both(source).await;
    assert_eq!(
        index, table,
        "executors disagree on `{source}`:\n  index = {index:?}\n  table = {table:?}"
    );
    index
}

fn list_of(n: &Normalized) -> &Vec<String> {
    match n {
        Normalized::List(items) => items,
        other => panic!("expected a list, got {other:?}"),
    }
}

#[tokio::test]
async fn list_returns_every_record_in_the_same_order() {
    let r = agree("LIST").await;
    assert_eq!(list_of(&r), &vec!["a", "b", "c", "d"]);
}

#[tokio::test]
async fn count_agrees() {
    assert_eq!(agree("COUNT").await, Normalized::Count(4));
}

#[tokio::test]
async fn table_projects_named_columns_and_blanks_a_missing_one() {
    let r = agree("TABLE status, nonexistent").await;
    match r {
        Normalized::Table(columns, rows) => {
            assert_eq!(columns, vec!["status", "nonexistent"]);
            assert_eq!(rows[0], vec!["in-progress".to_string(), String::new()]);
            assert_eq!(rows[3], vec![String::new(), String::new()]);
        }
        other => panic!("expected a table, got {other:?}"),
    }
}

#[tokio::test]
async fn string_equality_agrees() {
    let r = agree(r#"LIST WHERE status = "in-progress""#).await;
    assert_eq!(list_of(&r), &vec!["a", "c"]);
}

#[tokio::test]
async fn a_missing_value_never_matches_not_equal() {
    let r = agree(r#"LIST WHERE status != "done""#).await;
    assert_eq!(list_of(&r), &vec!["a", "c"]);
}

#[tokio::test]
async fn numeric_comparison_is_numeric_not_lexical() {
    let r = agree("LIST WHERE priority >= 2").await;
    assert_eq!(list_of(&r), &vec!["a", "c"]);
}

#[tokio::test]
async fn a_number_literal_never_matches_a_non_numeric_value() {
    let r = agree("LIST WHERE code >= 0").await;
    assert!(list_of(&r).is_empty());
}

#[tokio::test]
async fn a_string_literal_matches_a_value_that_looks_numeric() {
    let r = agree(r#"LIST WHERE code = "007""#).await;
    assert_eq!(list_of(&r), &vec!["a"]);
}

#[tokio::test]
async fn boolean_equality_agrees() {
    let r = agree("LIST WHERE done = true").await;
    assert_eq!(list_of(&r), &vec!["a"]);
}

#[tokio::test]
async fn a_boolean_literal_never_matches_a_non_boolean_value() {
    let r = agree("LIST WHERE status = false").await;
    assert!(list_of(&r).is_empty());
}

#[tokio::test]
async fn and_chains_agree() {
    let r = agree(r#"LIST WHERE status = "in-progress" AND priority >= 3"#).await;
    assert_eq!(list_of(&r), &vec!["a"]);
}

#[tokio::test]
async fn sort_ascending_puts_missing_values_last() {
    let r = agree("LIST SORT priority ASC").await;
    assert_eq!(list_of(&r), &vec!["b", "c", "a", "d"]);
}

#[tokio::test]
async fn sort_descending_still_puts_missing_values_last() {
    let r = agree("LIST SORT priority DESC").await;
    assert_eq!(list_of(&r), &vec!["a", "c", "b", "d"]);
}

#[tokio::test]
async fn sort_on_a_text_column_agrees() {
    let r = agree("LIST SORT code ASC").await;
    assert_eq!(list_of(&r), &vec!["a", "b", "d", "c"]);
}

#[tokio::test]
async fn sort_on_an_unknown_column_agrees() {
    let r = agree("LIST SORT nonexistent ASC").await;
    assert_eq!(list_of(&r), &vec!["a", "b", "c", "d"]);
}
