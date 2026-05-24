//! `cubical-index` — libSQL schema and queries.
//!
//! Owns the on-disk index database at `<vault>/.cubical/index.db`.
//! All schema changes go through the linear migration runner in this crate.
//! See `docs/layer-0-spec.md` §7.
//!
//! ## Public surface
//!
//! - [`open_index`] — open or create the index database at a given path
//!   and bring its schema up to date.
//! - [`IndexConn`] — handle to the open database.
//! - [`IndexError`] — every fallible operation returns
//!   `Result<T, IndexError>`. The consolidated `CubicalError` in
//!   `cubical-core` (per `docs/layer-0-spec.md` §9) lands when commands
//!   start crossing crate boundaries; until then this crate keeps its
//!   own focused error type.
//!
//! Query helpers (insert/lookup against `files`, audit logging, etc.)
//! land alongside the vault scanner in a subsequent session.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod error;
mod links;
mod migrations;
mod runner;

pub use error::IndexError;
pub use links::{links_from, links_to, replace_links_for_file, LinkRow};
pub use migrations::{Migration, MIGRATIONS};
pub use runner::{open_index, IndexConn};
