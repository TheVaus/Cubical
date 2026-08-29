use std::collections::HashMap;

use cubical_index::{fold_name, IndexConn};
use libsql::params;

use crate::error::GraphError;
use crate::model::{EdgeKind, GraphEdge, GraphModel, GraphNode, NodeId, NodeKind};

const MARKDOWN_TYPE_ID: &str = "markdown";

struct Builder {
    nodes: Vec<GraphNode>,
    index: HashMap<(NodeKind, String), NodeId>,
}

impl Builder {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn intern(&mut self, kind: NodeKind, key: &str, label: &str) -> NodeId {
        if let Some(id) = self.index.get(&(kind, key.to_string())) {
            return *id;
        }
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(GraphNode {
            id,
            kind,
            key: key.to_string(),
            label: label.to_string(),
        });
        self.index.insert((kind, key.to_string()), id);
        id
    }

    fn get(&self, kind: NodeKind, key: &str) -> Option<NodeId> {
        self.index.get(&(kind, key.to_string())).copied()
    }
}

fn label_for_path(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub async fn build_model(conn: &IndexConn) -> Result<GraphModel, GraphError> {
    let mut b = Builder::new();
    let mut edges: Vec<GraphEdge> = Vec::new();

    let mut rows = conn
        .connection()
        .query("SELECT path, type_id FROM files ORDER BY path", params![])
        .await?;
    while let Some(r) = rows.next().await? {
        let path: String = r.get(0)?;
        let type_id: String = r.get(1)?;
        let kind = if type_id == MARKDOWN_TYPE_ID {
            NodeKind::Note
        } else {
            NodeKind::Attachment
        };
        let label = label_for_path(&path).to_string();
        b.intern(kind, &path, &label);
    }

    let mut rows = conn
        .connection()
        .query(
            "SELECT source_path, target_raw, target_path, is_embed FROM links \
             ORDER BY source_path, position",
            params![],
        )
        .await?;
    while let Some(r) = rows.next().await? {
        let source_path: String = r.get(0)?;
        let target_raw: String = r.get(1)?;
        let target_path: Option<String> = r.get(2)?;
        let is_embed: i64 = r.get(3)?;
        let Some(source) = b
            .get(NodeKind::Note, &source_path)
            .or_else(|| b.get(NodeKind::Attachment, &source_path))
        else {
            continue;
        };
        match target_path {
            Some(t) => {
                let Some(target) = b
                    .get(NodeKind::Note, &t)
                    .or_else(|| b.get(NodeKind::Attachment, &t))
                else {
                    continue;
                };
                let kind = if is_embed == 0 {
                    EdgeKind::Link
                } else {
                    EdgeKind::Embed
                };
                edges.push(GraphEdge {
                    source,
                    target,
                    kind,
                });
            }
            None => {
                let key = fold_name(&target_raw);
                let target = b.intern(NodeKind::Ghost, &key, &target_raw);
                edges.push(GraphEdge {
                    source,
                    target,
                    kind: EdgeKind::Ghost,
                });
            }
        }
    }

    let mut rows = conn
        .connection()
        .query(
            "SELECT DISTINCT file_path, tag_path FROM tags ORDER BY tag_path, file_path",
            params![],
        )
        .await?;
    while let Some(r) = rows.next().await? {
        let file_path: String = r.get(0)?;
        let tag_path: String = r.get(1)?;
        let Some(source) = b.get(NodeKind::Note, &file_path) else {
            continue;
        };
        let target = b.intern(NodeKind::Tag, &tag_path, &tag_path);
        edges.push(GraphEdge {
            source,
            target,
            kind: EdgeKind::Tag,
        });
    }

    Ok(GraphModel::new(b.nodes, edges))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_index::{open_index, replace_links_for_file, LinkRow};
    use libsql::params;
    use tempfile::TempDir;

    async fn open_test_index() -> (TempDir, IndexConn) {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().join("index.db");
        let conn = open_index(&path).await.expect("open");
        (dir, conn)
    }

    async fn seed_file(conn: &IndexConn, path: &str, type_id: &str) {
        conn.connection()
            .execute(
                "INSERT INTO files (path, type_id, size_bytes, mtime_unix, \
                 content_hash, last_seen, created_at, updated_at) \
                 VALUES (?1, ?2, 0, 0, '', 0, 0, 0)",
                params![path, type_id],
            )
            .await
            .expect("seed files row");
    }

    async fn seed_tag(conn: &IndexConn, file_path: &str, tag_path: &str) {
        conn.connection()
            .execute(
                "INSERT INTO tags (file_path, tag_path, source) VALUES (?1, ?2, 'inline')",
                params![file_path, tag_path],
            )
            .await
            .expect("seed tags row");
    }

    fn link(target_raw: &str, target_path: Option<&str>) -> LinkRow {
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

    fn kinds(m: &GraphModel, kind: NodeKind) -> Vec<String> {
        let mut v: Vec<String> = m
            .nodes()
            .iter()
            .filter(|n| n.kind == kind)
            .map(|n| n.key.clone())
            .collect();
        v.sort();
        v
    }

    #[tokio::test]
    async fn markdown_files_become_note_nodes_and_others_attachments() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md", "markdown").await;
        seed_file(&conn, "img.png", "image").await;
        let m = build_model(&conn).await.expect("build");
        assert_eq!(kinds(&m, NodeKind::Note), vec!["a.md"]);
        assert_eq!(kinds(&m, NodeKind::Attachment), vec!["img.png"]);
    }

    #[tokio::test]
    async fn unresolved_links_become_one_ghost_node_per_target() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md", "markdown").await;
        seed_file(&conn, "b.md", "markdown").await;
        replace_links_for_file(&conn, "a.md", &[link("Nowhere", None)])
            .await
            .expect("links a");
        replace_links_for_file(&conn, "b.md", &[link("nowhere", None)])
            .await
            .expect("links b");
        let m = build_model(&conn).await.expect("build");
        assert_eq!(kinds(&m, NodeKind::Ghost), vec!["nowhere"]);
        assert_eq!(
            m.edges()
                .iter()
                .filter(|e| e.kind == EdgeKind::Ghost)
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn tags_become_nodes_with_an_edge_per_tagged_file() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md", "markdown").await;
        seed_tag(&conn, "a.md", "work").await;
        let m = build_model(&conn).await.expect("build");
        assert_eq!(kinds(&m, NodeKind::Tag), vec!["work"]);
        assert_eq!(
            m.edges().iter().filter(|e| e.kind == EdgeKind::Tag).count(),
            1
        );
    }

    #[tokio::test]
    async fn resolved_links_become_link_edges_between_notes() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md", "markdown").await;
        seed_file(&conn, "b.md", "markdown").await;
        replace_links_for_file(&conn, "a.md", &[link("B", Some("b.md"))])
            .await
            .expect("links");
        let m = build_model(&conn).await.expect("build");
        let e: Vec<&GraphEdge> = m
            .edges()
            .iter()
            .filter(|e| e.kind == EdgeKind::Link)
            .collect();
        assert_eq!(e.len(), 1);
        assert_eq!(m.degree(e[0].source), 1);
    }

    #[tokio::test]
    async fn an_empty_vault_builds_an_empty_model() {
        let (_dir, conn) = open_test_index().await;
        let m = build_model(&conn).await.expect("build");
        assert!(m.nodes().is_empty());
        assert!(m.edges().is_empty());
    }
}
