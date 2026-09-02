use serde::Serialize;

use crate::ast::Query;
use crate::error::QueryError;
use crate::exec_index;
use crate::exec_table;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteRef {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListItem {
    pub text: String,
    pub note: Option<NoteRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub note: Option<NoteRef>,
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryResult {
    List {
        items: Vec<ListItem>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Row>,
        row_label: Option<String>,
    },
    Count {
        count: usize,
    },
}

pub enum Relation<'a> {
    Index(&'a cubical_index::IndexConn),
    Table(&'a cubical_table::Table),
}

#[must_use]
pub fn run_table(table: &cubical_table::Table, q: &Query) -> QueryResult {
    exec_table::run(table, q)
}

pub async fn run(relation: Relation<'_>, q: &Query) -> Result<QueryResult, QueryError> {
    match relation {
        Relation::Index(conn) => exec_index::run(conn, q).await,
        Relation::Table(table) => Ok(exec_table::run(table, q)),
    }
}
