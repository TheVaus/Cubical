#![forbid(unsafe_code)]

mod ast;
mod error;
mod exec;
mod parser;
mod plan;

pub use ast::{Command, Cond, Op, Query, Sort, SortDir, Source, Value};
pub use error::{ParseError, QueryError};
pub use exec::{run, NoteRef, QueryResult, Row};
pub use parser::parse;
