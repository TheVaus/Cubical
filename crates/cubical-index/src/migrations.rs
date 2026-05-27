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
/// - `v1` (L0): bedrock tables — `schema_version`, `files`, `config`,
///   `audit_log` — and their indexes.
/// - `v2` (L1): the `frontmatter` table for parsed YAML keys, keyed
///   on `(file_path, key)` with JSON-encoded values.
/// - `v3` (L3 Session A): the `links` table for wiki-link occurrences.
/// - `v4` (L3 Session D): the `tags` table for inline + frontmatter
///   tag occurrences.
///
/// Subsequent layers append entries here.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        up: include_str!("../migrations/001_initial.sql"),
    },
    Migration {
        version: 2,
        up: include_str!("../migrations/002_frontmatter.sql"),
    },
    Migration {
        version: 3,
        up: include_str!("../migrations/003_links.sql"),
    },
    Migration {
        version: 4,
        up: include_str!("../migrations/004_tags.sql"),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_004_creates_tags_table() {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == 4)
            .expect("004 migration must be registered");
        let sql = m.up;
        assert!(sql.contains("CREATE TABLE tags"), "must create tags table");
        assert!(sql.contains("file_path"));
        assert!(sql.contains("tag_path"));
        assert!(sql.contains("source"));
        assert!(sql.contains("idx_tags_path"));
    }

    #[test]
    fn migration_003_creates_links_table() {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == 3)
            .expect("003 migration must be registered");
        let sql = m.up;
        assert!(
            sql.contains("CREATE TABLE links"),
            "must create links table"
        );
        assert!(sql.contains("source_path"));
        assert!(sql.contains("target_path"));
        assert!(sql.contains("idx_links_source"));
        assert!(sql.contains("idx_links_target"));
    }

    #[test]
    fn migrations_are_in_strict_ascending_order() {
        for pair in MIGRATIONS.windows(2) {
            assert_eq!(
                pair[1].version,
                pair[0].version + 1,
                "migration versions must be contiguous and ascending"
            );
        }
    }
}
