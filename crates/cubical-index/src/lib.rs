//! `cubical-index` — libSQL schema and queries.
//!
//! Owns the on-disk index database at `<vault>/.cubical/index.db`.
//! All schema changes go through the linear migration runner in this crate.
//! See `docs/layer-0-spec.md` §7.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
