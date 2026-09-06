#![forbid(unsafe_code)]

mod ast;
mod error;
mod exec;
mod exec_index;
mod exec_table;
mod parser;
mod plan;

#[cfg(test)]
mod conformance;

pub use ast::{Command, Cond, Op, Query, Sort, SortDir, Source, Value};
pub use error::{ParseError, QueryError};
pub use exec::{run, run_table, ListItem, NoteRef, QueryResult, Relation, Row};
pub use exec_index::NOTE_ROW_LABEL;
pub use parser::parse;
