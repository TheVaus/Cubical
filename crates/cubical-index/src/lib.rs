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

mod blocks;
mod error;
mod links;
mod migrations;
mod pending;
mod runner;
mod tags;

pub use blocks::{
    block_exists, blocks_for_file, broken_block_refs, replace_block_refs_for_file,
    replace_blocks_for_file, BlockRefRow, BlockRow, BrokenBlockRef,
};
pub use error::IndexError;
pub use links::{
    backlinks_for, files_for_link_query, links_from, links_to, replace_links_for_file, BacklinkRow,
    LinkRow,
};
pub use migrations::{Migration, MIGRATIONS};
pub use pending::{
    delete_pending_for_target, delete_rename_op, enqueue_pending, list_recent_rename_ops,
    pending_count_breakdown, pending_count_for_target, pending_count_total, pending_for_target,
    pending_targets, NewPendingRewrite, PendingRewriteRow, RenameOpRow, RewriteKind,
};
pub use runner::{open_index, IndexConn};
pub use tags::{
    files_for_tag_prefix, replace_tags_for_file, tag_paths_for_prefix, tags_for_file, TagRow,
    TagSource,
};
