//! `cubical-query` — the Dataview-style query language for Cubical.
//!
//! Compiles a small DQL-flavored DSL (`LIST` / `TABLE` / `COUNT` with
//! `FROM` / `WHERE` / `SORT`) into parameterized SQL over the
//! `cubical-index` libSQL tables. See
//! `docs/superpowers/specs/2026-06-14-l4-d-dataview-design.md`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod ast;
mod error;

pub use ast::{Command, Cond, Op, Query, Sort, SortDir, Source, Value};
pub use error::{ParseError, QueryError};
