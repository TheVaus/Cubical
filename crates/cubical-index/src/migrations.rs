#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: u32,
    pub up: &'static str,
}

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
    Migration {
        version: 5,
        up: include_str!("../migrations/005_blocks.sql"),
    },
    Migration {
        version: 6,
        up: include_str!("../migrations/006_pending_rewrites.sql"),
    },
    Migration {
        version: 7,
        up: include_str!("../migrations/007_folders.sql"),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_007_creates_folders_table() {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == 7)
            .expect("007 migration must be registered");
        let sql = m.up;
        assert!(
            sql.contains("CREATE TABLE folders"),
            "must create folders table"
        );
        assert!(sql.contains("path"));
        assert!(sql.contains("last_seen"));
    }

    #[test]
    fn migration_006_creates_pending_rewrites_table() {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == 6)
            .expect("006 migration must be registered");
        let sql = m.up;
        assert!(
            sql.contains("CREATE TABLE pending_rewrites"),
            "must create pending_rewrites table"
        );
        assert!(sql.contains("target_file"));
        assert!(sql.contains("rewrite_kind"));
        assert!(sql.contains("old_token"));
        assert!(sql.contains("new_token"));
        assert!(sql.contains("rename_op_id"));
        assert!(sql.contains("idx_pending_target"));
        assert!(sql.contains("idx_pending_op"));
    }

    #[test]
    fn migration_005_creates_blocks_tables() {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == 5)
            .expect("005 migration must be registered");
        let sql = m.up;
        assert!(
            sql.contains("CREATE TABLE blocks"),
            "must create blocks table"
        );
        assert!(
            sql.contains("CREATE TABLE block_refs"),
            "must create block_refs table"
        );
        assert!(sql.contains("position_hint"));
        assert!(sql.contains("target_block_id"));
        assert!(sql.contains("idx_block_refs_target"));
    }

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
