//! Linear schema migrations.
//!
//! Each [`Migration`] is a `(version, sql)` pair. The runner in
//! [`crate::runner`] applies all migrations whose version exceeds the
//! on-disk `schema_version`, in version order, inside a single
//! transaction. New migrations are appended to [`MIGRATIONS`] in
//! ascending version order; the runner trusts that ordering.
//!
//! ## Adding a migration
//!
//! 1. Drop a new file `crates/cubical-index/migrations/NNN_<name>.sql`
//!    where `NNN` is zero-padded and one greater than the previous one.
//! 2. Append a new [`Migration`] entry to [`MIGRATIONS`] with the next
//!    version number, wired via `include_str!`.
//! 3. Never edit a migration that has shipped — write a new one that
//!    fixes it forward.

/// A single linear schema migration step.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Monotonically increasing version. Must equal the previous
    /// migration's version + 1.
    pub version: u32,
    /// The SQL to apply when bringing a database from `version - 1` to
    /// `version`. May contain multiple statements; executed via
    /// `Connection::execute_batch`.
    pub up: &'static str,
}

/// All known migrations, in ascending version order.
///
/// Layer 0 ships only `v1`, which creates the four bedrock tables
/// (`schema_version`, `files`, `config`, `audit_log`) and their indexes.
/// Subsequent layers append entries here.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    up: include_str!("../migrations/001_initial.sql"),
}];
