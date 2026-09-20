use libsql::params;

use crate::error::IndexError;
use crate::fold::{fold_name, fold_prefix_upper_bound};
use crate::runner::IndexConn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagSource {
    Inline,
    Frontmatter,
}

impl TagSource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            TagSource::Inline => "inline",
            TagSource::Frontmatter => "frontmatter",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRow {
    pub tag_path: String,
    pub source: TagSource,
}

pub async fn replace_tags_for_file(
    conn: &IndexConn,
    file_path: &str,
    rows: &[TagRow],
) -> Result<(), IndexError> {
    let c = conn.connection();
    c.execute("DELETE FROM tags WHERE file_path = ?1", params![file_path])
        .await?;
    for r in rows {
        c.execute(
            "INSERT OR IGNORE INTO tags (file_path, tag_path, source, tag_fold) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                file_path,
                r.tag_path.clone(),
                r.source.as_str(),
                fold_name(&r.tag_path)
            ],
        )
        .await?;
    }
    Ok(())
}

pub(crate) const FILES_FOR_TAG_SQL: &str = "SELECT DISTINCT file_path FROM tags \
     WHERE tag_fold = ?1 OR (tag_fold >= ?2 AND tag_fold < ?3) \
     ORDER BY file_path";

pub async fn files_for_tag_prefix(
    conn: &IndexConn,
    tag_path: &str,
) -> Result<Vec<String>, IndexError> {
    let needle = fold_name(tag_path);
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let descendants = format!("{needle}/");
    let Some(beyond) = fold_prefix_upper_bound(&descendants) else {
        return Ok(Vec::new());
    };
    let mut rows = conn
        .connection()
        .query(FILES_FOR_TAG_SQL, params![needle, descendants, beyond])
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        out.push(path);
    }
    Ok(out)
}

pub(crate) const TAG_PATHS_FOR_PREFIX_SQL: &str = "SELECT DISTINCT tag_path FROM tags \
     WHERE tag_fold >= ?1 AND tag_fold < ?2 \
     ORDER BY tag_path LIMIT ?3";

const ALL_TAG_PATHS_SQL: &str = "SELECT DISTINCT tag_path FROM tags \
     ORDER BY tag_path LIMIT ?1";

pub async fn tag_paths_for_prefix(
    conn: &IndexConn,
    query: &str,
    limit: u32,
) -> Result<Vec<String>, IndexError> {
    let needle = fold_name(query);
    let mut rows = match fold_prefix_upper_bound(&needle) {
        None => {
            conn.connection()
                .query(ALL_TAG_PATHS_SQL, params![i64::from(limit)])
                .await?
        }
        Some(beyond) => {
            conn.connection()
                .query(
                    TAG_PATHS_FOR_PREFIX_SQL,
                    params![needle, beyond, i64::from(limit)],
                )
                .await?
        }
    };
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

pub async fn all_tag_paths(conn: &IndexConn) -> Result<Vec<String>, IndexError> {
    let mut rows = conn
        .connection()
        .query("SELECT DISTINCT tag_path FROM tags ORDER BY tag_path", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagAssignment {
    pub tag_path: String,
    pub file_path: String,
}

pub async fn all_tag_assignments(conn: &IndexConn) -> Result<Vec<TagAssignment>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT DISTINCT tag_path, file_path FROM tags \
             ORDER BY tag_path, file_path",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(TagAssignment {
            tag_path: row.get(0)?,
            file_path: row.get(1)?,
        });
    }
    Ok(out)
}

pub async fn tags_for_file(conn: &IndexConn, file_path: &str) -> Result<Vec<TagRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT tag_path, source FROM tags WHERE file_path = ?1 \
             ORDER BY source, tag_path",
            params![file_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let tag_path: String = row.get(0)?;
        let source_str: String = row.get(1)?;
        let source = match source_str.as_str() {
            "inline" => TagSource::Inline,
            "frontmatter" => TagSource::Frontmatter,
            other => {
                return Err(IndexError::LibSql(libsql::Error::Misuse(format!(
                    "unknown tags.source: {other}"
                ))));
            }
        };
        out.push(TagRow { tag_path, source });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::TempDir;

    async fn seed_file(conn: &IndexConn, path: &str) {
        conn.connection()
            .execute(
                "INSERT INTO files \
                 (path, type_id, size_bytes, mtime_unix, content_hash, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', 0, 0, 0)",
                params![path],
            )
            .await
            .expect("seed files row");
    }

    fn row(tag: &str, source: TagSource) -> TagRow {
        TagRow {
            tag_path: tag.into(),
            source,
        }
    }

    fn assignment(tag: &str, file: &str) -> TagAssignment {
        TagAssignment {
            tag_path: tag.into(),
            file_path: file.into(),
        }
    }

    async fn open_test_index() -> (TempDir, IndexConn) {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().join("index.db");
        let conn = open_index(&path).await.expect("open");
        (dir, conn)
    }

    #[tokio::test]
    async fn replace_then_lookup_round_trip() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let rows = vec![
            row("todo", TagSource::Inline),
            row("project/cubical", TagSource::Frontmatter),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 2);
        assert!(got.contains(&row("todo", TagSource::Inline)));
        assert!(got.contains(&row("project/cubical", TagSource::Frontmatter)));
    }

    #[tokio::test]
    async fn all_tag_paths_returns_distinct_sorted() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("project/cubical", TagSource::Inline),
                row("alpha", TagSource::Inline),
            ],
        )
        .await
        .expect("replace a");
        replace_tags_for_file(
            &conn,
            "b.md",
            &[row("project/cubical", TagSource::Frontmatter)],
        )
        .await
        .expect("replace b");
        let tags = all_tag_paths(&conn).await.expect("all tags");
        assert_eq!(
            tags,
            vec!["alpha".to_string(), "project/cubical".to_string()]
        );
    }

    async fn plan_for(conn: &IndexConn, sql: &str, args: &[&str]) -> String {
        let owned: Vec<libsql::Value> = args
            .iter()
            .map(|a| libsql::Value::Text((*a).to_string()))
            .collect();
        let mut rows = conn
            .connection()
            .query(&format!("EXPLAIN QUERY PLAN {sql}"), owned)
            .await
            .expect("explain");
        let mut out = String::new();
        while let Some(row) = rows.next().await.expect("row") {
            out.push_str(&row.get::<String>(3).expect("detail"));
            out.push('\n');
        }
        out
    }

    #[tokio::test]
    async fn tag_matching_reads_the_fold_index_instead_of_scanning() {
        let (_dir, conn) = open_test_index().await;
        let carriers = plan_for(
            &conn,
            FILES_FOR_TAG_SQL,
            &["projekt", "projekt/", "projekt0"],
        )
        .await;
        assert!(carriers.contains("idx_tags_fold"), "{carriers}");
        assert!(!carriers.contains("SCAN tags"), "{carriers}");

        let prefixes = plan_for(&conn, TAG_PATHS_FOR_PREFIX_SQL, &["pro", "prp", "10"]).await;
        assert!(prefixes.contains("idx_tags_fold"), "{prefixes}");
        assert!(!prefixes.contains("SCAN tags"), "{prefixes}");
    }

    #[tokio::test]
    async fn an_empty_tag_never_matches_a_row_awaiting_backfill() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        conn.connection()
            .execute(
                "INSERT INTO tags (file_path, tag_path, source) VALUES ('a.md', 'todo', 'inline')",
                (),
            )
            .await
            .expect("seed unfolded row");

        assert!(files_for_tag_prefix(&conn, "")
            .await
            .expect("lookup")
            .is_empty());
    }

    #[tokio::test]
    async fn a_non_ascii_tag_matches_the_same_fold_the_vault_uses_for_names() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("Projekt/CAFÉ", TagSource::Inline)])
            .await
            .expect("replace");

        assert!(crate::names_eq_folded("Projekt/CAFÉ", "projekt/café"));
        assert_eq!(
            files_for_tag_prefix(&conn, "projekt/café")
                .await
                .expect("lookup"),
            vec!["a.md".to_string()]
        );
        assert_eq!(
            tag_paths_for_prefix(&conn, "projekt/CAFÉ", 10)
                .await
                .expect("prefix"),
            vec!["Projekt/CAFÉ".to_string()]
        );
    }

    #[tokio::test]
    async fn all_tag_paths_empty_when_no_tags() {
        let (_dir, conn) = open_test_index().await;
        assert!(all_tag_paths(&conn).await.expect("all tags").is_empty());
    }

    #[tokio::test]
    async fn all_tag_assignments_pairs_every_tag_with_every_carrier() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("project/cubical", TagSource::Inline),
                row("alpha", TagSource::Inline),
            ],
        )
        .await
        .expect("replace a");
        replace_tags_for_file(
            &conn,
            "b.md",
            &[row("project/cubical", TagSource::Frontmatter)],
        )
        .await
        .expect("replace b");
        let got = all_tag_assignments(&conn).await.expect("assignments");
        assert_eq!(
            got,
            vec![
                assignment("alpha", "a.md"),
                assignment("project/cubical", "a.md"),
                assignment("project/cubical", "b.md"),
            ]
        );
    }

    #[tokio::test]
    async fn all_tag_assignments_collapses_a_tag_carried_by_two_sources() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("todo", TagSource::Inline),
                row("todo", TagSource::Frontmatter),
            ],
        )
        .await
        .expect("replace");
        let got = all_tag_assignments(&conn).await.expect("assignments");
        assert_eq!(got, vec![assignment("todo", "a.md")]);
    }

    #[tokio::test]
    async fn all_tag_assignments_empty_when_no_tags() {
        let (_dir, conn) = open_test_index().await;
        assert!(all_tag_assignments(&conn)
            .await
            .expect("assignments")
            .is_empty());
    }

    #[tokio::test]
    async fn replace_is_atomic() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("old", TagSource::Inline)])
            .await
            .expect("first");
        replace_tags_for_file(&conn, "a.md", &[row("new", TagSource::Inline)])
            .await
            .expect("second");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got, vec![row("new", TagSource::Inline)]);
    }

    #[tokio::test]
    async fn duplicate_same_triple_is_idempotent() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let rows = vec![
            row("todo", TagSource::Inline),
            row("todo", TagSource::Inline),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got, vec![row("todo", TagSource::Inline)]);
    }

    #[tokio::test]
    async fn same_tag_different_source_is_two_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let rows = vec![
            row("todo", TagSource::Inline),
            row("todo", TagSource::Frontmatter),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 2);
    }

    #[tokio::test]
    async fn empty_rows_clears_existing_tags() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .expect("seed");
        replace_tags_for_file(&conn, "a.md", &[])
            .await
            .expect("clear");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn files_for_tag_prefix_exact_match_returns_carriers() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        seed_file(&conn, "c.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .expect("a");
        replace_tags_for_file(&conn, "b.md", &[row("todo", TagSource::Frontmatter)])
            .await
            .expect("b");
        replace_tags_for_file(&conn, "c.md", &[row("done", TagSource::Inline)])
            .await
            .expect("c");
        let got = files_for_tag_prefix(&conn, "todo").await.expect("query");
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_includes_descendants() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "parent.md").await;
        seed_file(&conn, "child.md").await;
        seed_file(&conn, "grand.md").await;
        seed_file(&conn, "sibling.md").await;
        replace_tags_for_file(&conn, "parent.md", &[row("project", TagSource::Inline)])
            .await
            .expect("parent");
        replace_tags_for_file(
            &conn,
            "child.md",
            &[row("project/cubical", TagSource::Inline)],
        )
        .await
        .expect("child");
        replace_tags_for_file(
            &conn,
            "grand.md",
            &[row("project/cubical/l3", TagSource::Inline)],
        )
        .await
        .expect("grand");
        replace_tags_for_file(&conn, "sibling.md", &[row("projection", TagSource::Inline)])
            .await
            .expect("sibling");

        let got = files_for_tag_prefix(&conn, "project").await.expect("query");
        assert_eq!(
            got,
            vec![
                "child.md".to_string(),
                "grand.md".to_string(),
                "parent.md".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn files_for_tag_prefix_is_case_insensitive() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("ToDo", TagSource::Inline)])
            .await
            .expect("a");
        replace_tags_for_file(&conn, "b.md", &[row("TODO/today", TagSource::Frontmatter)])
            .await
            .expect("b");
        let got = files_for_tag_prefix(&conn, "todo").await.expect("lower");
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
        let got = files_for_tag_prefix(&conn, "TODO").await.expect("upper");
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_dedupes_when_same_file_has_inline_and_frontmatter() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let rows = vec![
            row("todo", TagSource::Inline),
            row("todo", TagSource::Frontmatter),
        ];
        replace_tags_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = files_for_tag_prefix(&conn, "todo").await.expect("query");
        assert_eq!(got, vec!["a.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_escapes_like_underscores() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "match.md").await;
        seed_file(&conn, "wildcard.md").await;
        replace_tags_for_file(&conn, "match.md", &[row("my_tag", TagSource::Inline)])
            .await
            .expect("match");
        replace_tags_for_file(&conn, "wildcard.md", &[row("myXtag", TagSource::Inline)])
            .await
            .expect("wildcard");
        let got = files_for_tag_prefix(&conn, "my_tag").await.expect("query");
        assert_eq!(got, vec!["match.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_tag_prefix_unknown_returns_empty() {
        let (_dir, conn) = open_test_index().await;
        let got = files_for_tag_prefix(&conn, "nope").await.expect("query");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn tag_paths_for_prefix_distinct_prefix_match_case_insensitive() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("Project", TagSource::Inline),
                row("project/cubical", TagSource::Frontmatter),
            ],
        )
        .await
        .unwrap();
        replace_tags_for_file(&conn, "b.md", &[row("done", TagSource::Inline)])
            .await
            .unwrap();

        let got = tag_paths_for_prefix(&conn, "proj", 50).await.unwrap();
        assert_eq!(
            got,
            vec!["Project".to_string(), "project/cubical".to_string()]
        );
        assert!(tag_paths_for_prefix(&conn, "zzz", 50)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn tag_paths_for_prefix_empty_query_lists_all_distinct_limited() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .unwrap();
        replace_tags_for_file(&conn, "b.md", &[row("todo", TagSource::Frontmatter)])
            .await
            .unwrap();
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("todo", TagSource::Inline),
                row("area", TagSource::Inline),
            ],
        )
        .await
        .unwrap();

        let all = tag_paths_for_prefix(&conn, "", 50).await.unwrap();
        assert_eq!(all, vec!["area".to_string(), "todo".to_string()]);

        let limited = tag_paths_for_prefix(&conn, "", 1).await.unwrap();
        assert_eq!(limited, vec!["area".to_string()]);
    }

    #[tokio::test]
    async fn tag_paths_for_prefix_escapes_like_underscore() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(
            &conn,
            "a.md",
            &[
                row("my_tag", TagSource::Inline),
                row("myXtag", TagSource::Inline),
            ],
        )
        .await
        .unwrap();
        let got = tag_paths_for_prefix(&conn, "my_", 50).await.unwrap();
        assert_eq!(got, vec!["my_tag".to_string()]);
    }

    #[tokio::test]
    async fn cascade_delete_removes_tag_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
            .await
            .expect("seed");
        conn.connection()
            .execute("DELETE FROM files WHERE path = 'a.md'", ())
            .await
            .expect("delete file");
        let got = tags_for_file(&conn, "a.md").await.expect("lookup");
        assert!(got.is_empty(), "tag rows should cascade-delete");
    }
}
