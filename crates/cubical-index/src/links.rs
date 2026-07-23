use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

#[derive(Debug, Clone, PartialEq)]
pub struct LinkRow {
    pub target_raw: String,
    pub target_path: Option<String>,
    pub anchor_kind: Option<String>,
    pub anchor_value: Option<String>,
    pub display_text: Option<String>,
    pub is_embed: bool,
    pub position: u64,
}

pub async fn replace_links_for_file(
    conn: &IndexConn,
    source_path: &str,
    rows: &[LinkRow],
) -> Result<(), IndexError> {
    let c = conn.connection();
    c.execute(
        "DELETE FROM links WHERE source_path = ?1",
        params![source_path],
    )
    .await?;
    for r in rows {
        c.execute(
            "INSERT INTO links \
             (source_path, target_raw, target_path, anchor_kind, anchor_value, \
              display_text, is_embed, position) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                source_path,
                r.target_raw.clone(),
                r.target_path.clone(),
                r.anchor_kind.clone(),
                r.anchor_value.clone(),
                r.display_text.clone(),
                i64::from(r.is_embed),
                r.position as i64,
            ],
        )
        .await?;
    }
    Ok(())
}

pub async fn links_from(conn: &IndexConn, source_path: &str) -> Result<Vec<LinkRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT target_raw, target_path, anchor_kind, anchor_value, \
                    display_text, is_embed, position \
             FROM links WHERE source_path = ?1 ORDER BY position",
            params![source_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row_to_link(&row)?);
    }
    Ok(out)
}

pub async fn links_to(conn: &IndexConn, target_path: &str) -> Result<Vec<LinkRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT target_raw, target_path, anchor_kind, anchor_value, \
                    display_text, is_embed, position \
             FROM links WHERE target_path = ?1 ORDER BY source_path, position",
            params![target_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row_to_link(&row)?);
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct BacklinkRow {
    pub source_path: String,
    pub target_raw: String,
    pub anchor_kind: Option<String>,
    pub anchor_value: Option<String>,
    pub display_text: Option<String>,
    pub is_embed: bool,
    pub position: u64,
}

pub async fn backlinks_for(
    conn: &IndexConn,
    target_path: &str,
) -> Result<Vec<BacklinkRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT source_path, target_raw, anchor_kind, anchor_value, \
                    display_text, is_embed, position \
             FROM links WHERE target_path = ?1 \
             ORDER BY source_path, position",
            params![target_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let is_embed_int: i64 = row.get(5)?;
        let position_int: i64 = row.get(6)?;
        out.push(BacklinkRow {
            source_path: row.get(0)?,
            target_raw: row.get(1)?,
            anchor_kind: row.get(2)?,
            anchor_value: row.get(3)?,
            display_text: row.get(4)?,
            is_embed: is_embed_int != 0,
            position: position_int.try_into().unwrap_or(0),
        });
    }
    Ok(out)
}

fn escape_like_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

pub async fn files_for_link_query(
    conn: &IndexConn,
    query: &str,
    limit: u32,
) -> Result<Vec<String>, IndexError> {
    let needle = query.to_lowercase();
    let like = format!("%{}%", escape_like_literal(&needle));
    let mut rows = conn
        .connection()
        .query(
            "SELECT path FROM files \
             WHERE type_id = 'markdown' \
               AND (?1 = '' OR LOWER(path) LIKE ?2 ESCAPE '\\') \
             ORDER BY path \
             LIMIT ?3",
            params![needle, like, i64::from(limit)],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

fn row_to_link(row: &libsql::Row) -> Result<LinkRow, IndexError> {
    let is_embed_int: i64 = row.get(5)?;
    let position_int: i64 = row.get(6)?;
    Ok(LinkRow {
        target_raw: row.get(0)?,
        target_path: row.get(1)?,
        anchor_kind: row.get(2)?,
        anchor_value: row.get(3)?,
        display_text: row.get(4)?,
        is_embed: is_embed_int != 0,
        position: position_int.try_into().unwrap_or(0),
    })
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

    fn row(target_raw: &str, target_path: Option<&str>) -> LinkRow {
        LinkRow {
            target_raw: target_raw.into(),
            target_path: target_path.map(String::from),
            anchor_kind: None,
            anchor_value: None,
            display_text: None,
            is_embed: false,
            position: 0,
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
        let rows = vec![row("Other Note", Some("other.md"))];
        replace_links_for_file(&conn, "a.md", &rows)
            .await
            .expect("replace");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert_eq!(got, rows);
    }

    #[tokio::test]
    async fn links_to_returns_backlinks() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        let rows_a = vec![row("Target", Some("target.md"))];
        let rows_b = vec![row("Target", Some("target.md"))];
        replace_links_for_file(&conn, "a.md", &rows_a)
            .await
            .expect("a");
        replace_links_for_file(&conn, "b.md", &rows_b)
            .await
            .expect("b");
        let back = links_to(&conn, "target.md").await.expect("backlinks");
        assert_eq!(back.len(), 2);
    }

    #[tokio::test]
    async fn replace_is_atomic() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_links_for_file(&conn, "a.md", &[row("Old", Some("old.md"))])
            .await
            .expect("first");
        replace_links_for_file(&conn, "a.md", &[row("New", Some("new.md"))])
            .await
            .expect("second");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].target_raw, "New");
    }

    #[tokio::test]
    async fn position_orders_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        let mut r1 = row("Second", Some("s.md"));
        r1.position = 100;
        let mut r2 = row("First", Some("f.md"));
        r2.position = 10;
        replace_links_for_file(&conn, "a.md", &[r1, r2])
            .await
            .expect("replace");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].target_raw, "First");
        assert_eq!(got[1].target_raw, "Second");
    }

    #[tokio::test]
    async fn cascade_delete_removes_link_rows() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_links_for_file(&conn, "a.md", &[row("X", Some("x.md"))])
            .await
            .expect("replace");
        conn.connection()
            .execute("DELETE FROM files WHERE path = 'a.md'", ())
            .await
            .expect("delete file");
        let got = links_from(&conn, "a.md").await.expect("lookup");
        assert!(got.is_empty(), "link rows should cascade-delete");
    }

    #[tokio::test]
    async fn backlinks_for_returns_source_path_and_orders_per_file() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "b.md").await;
        seed_file(&conn, "target.md").await;

        let mut a_row = row("Target", Some("target.md"));
        a_row.position = 50;
        let mut b_row_1 = row("Target", Some("target.md"));
        b_row_1.position = 200;
        let mut b_row_2 = row("Target", Some("target.md"));
        b_row_2.position = 10;

        replace_links_for_file(&conn, "a.md", &[a_row])
            .await
            .unwrap();
        replace_links_for_file(&conn, "b.md", &[b_row_2, b_row_1])
            .await
            .unwrap();

        let got = backlinks_for(&conn, "target.md").await.expect("backlinks");
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].source_path, "a.md");
        assert_eq!(got[0].position, 50);
        assert_eq!(got[1].source_path, "b.md");
        assert_eq!(got[1].position, 10);
        assert_eq!(got[2].source_path, "b.md");
        assert_eq!(got[2].position, 200);
    }

    #[tokio::test]
    async fn backlinks_for_returns_empty_when_no_links_point_here() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "lonely.md").await;
        let got = backlinks_for(&conn, "lonely.md").await.expect("ok");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn files_for_link_query_substring_case_insensitive() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "Daily/2026-05-28.md").await;
        seed_file(&conn, "notes/Project Cubical.md").await;
        seed_file(&conn, "notes/cubical-ast.md").await;
        seed_file(&conn, "archive/old.md").await;

        let got = files_for_link_query(&conn, "cubical", 50).await.unwrap();
        assert_eq!(
            got,
            vec![
                "notes/Project Cubical.md".to_string(),
                "notes/cubical-ast.md".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn files_for_link_query_empty_query_lists_all_markdown_ordered_and_limited() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "b.md").await;
        seed_file(&conn, "a.md").await;
        seed_file(&conn, "c.md").await;

        let all = files_for_link_query(&conn, "", 50).await.unwrap();
        assert_eq!(
            all,
            vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()]
        );

        let limited = files_for_link_query(&conn, "", 2).await.unwrap();
        assert_eq!(limited, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[tokio::test]
    async fn files_for_link_query_excludes_non_markdown_and_escapes_like() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "real_note.md").await;
        conn.connection()
            .execute(
                "INSERT INTO files \
                 (path, type_id, size_bytes, mtime_unix, content_hash, last_seen, created_at, updated_at) \
                 VALUES ('image.png', 'binary', 0, 0, '', 0, 0, 0)",
                (),
            )
            .await
            .unwrap();

        let got = files_for_link_query(&conn, "note", 50).await.unwrap();
        assert_eq!(got, vec!["real_note.md".to_string()]);

        let exact = files_for_link_query(&conn, "real_note", 50).await.unwrap();
        assert_eq!(exact, vec!["real_note.md".to_string()]);
    }
}
