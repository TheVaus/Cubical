//! Error types for the index crate.
//!
//! `cubical-index` exposes its own error type rather than the consolidated
//! `CubicalError` (which lives in `cubical-core` per `docs/layer-0-spec.md`
//! §9). At the time `cubical-index` is built, no command crosses crate
//! boundaries yet, so a local error keeps the dependency graph clean and
//! the variants tightly scoped to what this crate actually produces. The
//! conversion to `CubicalError` will land alongside the first vault command
//! that needs it.

use std::path::PathBuf;

/// Errors produced by the index crate.
///
/// All fallible operations in this crate return `Result<T, IndexError>`.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    /// I/O error while opening or accessing the database file.
    ///
    /// The path is captured so the user-facing layer can surface it without
    /// having to thread it through separately.
    #[error("io error opening index database at {path}: {source}")]
    Io {
        /// The database path that triggered the error.
        path: PathBuf,
        /// The underlying I/O error.
        #[source]
        source: std::io::Error,
    },

    /// Error from libSQL itself — a query failed, the database file is
    /// corrupt, a constraint was violated, etc.
    #[error("libsql error: {0}")]
    LibSql(#[from] libsql::Error),

    /// The on-disk schema is at a version newer than this build of Cubical
    /// knows how to read. Refuse to open rather than risk corrupting it.
    ///
    /// Carries the offending on-disk version. The highest version this
    /// build supports is the latest entry in [`MIGRATIONS`](crate::MIGRATIONS).
    #[error(
        "on-disk schema version {0} is newer than this build supports; \
         upgrade Cubical to open this vault"
    )]
    SchemaTooNew(u32),

    /// A row's enum-typed column carried a value this build doesn't
    /// recognize. Used by `pending_rewrites.rewrite_kind` (and any future
    /// enum column) so the read-back path can surface "corrupt or
    /// future-build" data without panicking.
    #[error("unknown enum value {value:?} in {table}.{column}")]
    UnknownEnum {
        /// Table the offending row belongs to.
        table: &'static str,
        /// Column the offending value came from.
        column: &'static str,
        /// The string the database returned.
        value: String,
    },
}
