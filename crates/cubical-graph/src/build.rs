use std::collections::HashMap;

use cubical_ast::note_title;
use cubical_index::{fold_name, IndexConn};
use libsql::params;

use crate::error::GraphError;
use crate::model::{EdgeKind, GraphEdge, GraphModel, GraphNode, NodeId, NodeKind};

const MARKDOWN_TYPE_ID: &str = "markdown";

#[derive(Default)]
struct Builder {
    nodes: Vec<GraphNode>,
    files: HashMap<String, NodeId>,
    ghosts: HashMap<String, NodeId>,
    tags: HashMap<String, NodeId>,
}

impl Builder {
    fn push(&mut self, kind: NodeKind, key: String, label: String) -> NodeId {
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(GraphNode {
            id,
            kind,
            key,
            label,
        });
        id
    }

    fn add_file(&mut self, kind: NodeKind, path: String) {
        let label = note_title(&path).to_string();
        let id = self.push(kind, path.clone(), label);
        self.files.insert(path, id);
    }

    fn file(&self, path: &str) -> Option<NodeId> {
        self.files.get(path).copied()
    }

    fn note(&self, path: &str) -> Option<NodeId> {
        self.file(path).filter(|id| {
            self.nodes
                .get(id.0 as usize)
                .is_some_and(|n| n.kind == NodeKind::Note)
        })
    }

    fn ghost(&mut self, target_raw: String) -> NodeId {
        let key = fold_name(&target_raw);
        if let Some(&id) = self.ghosts.get(&key) {
            return id;
        }
        let id = self.push(NodeKind::Ghost, key.clone(), target_raw);
        self.ghosts.insert(key, id);
        id
    }

    fn tag(&mut self, tag_path: String) -> NodeId {
        if let Some(&id) = self.tags.get(&tag_path) {
            return id;
        }
        let id = self.push(NodeKind::Tag, tag_path.clone(), tag_path.clone());
        self.tags.insert(tag_path, id);
        id
    }
}

pub async fn build_model(conn: &IndexConn) -> Result<GraphModel, GraphError> {
    let mut b = Builder::default();
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
        b.add_file(kind, path);
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
        let Some(source) = b.file(&source_path) else {
            continue;
        };
        let (target, kind) = match target_path {
            Some(t) => {
                let Some(target) = b.file(&t) else {
                    continue;
                };
                let kind = if is_embed == 0 {
                    EdgeKind::Link
                } else {
                    EdgeKind::Embed
                };
                (target, kind)
            }
            None => (b.ghost(target_raw), EdgeKind::Ghost),
        };
        edges.push(GraphEdge {
            source,
            target,
            kind,
        });
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
        let Some(source) = b.note(&file_path) else {
            continue;
        };
        let target = b.tag(tag_path);
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
    async fn embeds_reach_attachments_but_attachments_carry_no_tags() {
        let (_dir, conn) = open_test_index().await;
        seed_file(&conn, "a.md", "markdown").await;
        seed_file(&conn, "img.png", "image").await;
        seed_tag(&conn, "img.png", "work").await;
        let mut embed = link("img.png", Some("img.png"));
        embed.is_embed = true;
        replace_links_for_file(&conn, "a.md", &[embed])
            .await
            .expect("links");
        let m = build_model(&conn).await.expect("build");
        let kinds_of_edges: Vec<EdgeKind> = m.edges().iter().map(|e| e.kind).collect();
        assert_eq!(kinds_of_edges, vec![EdgeKind::Embed]);
        assert!(kinds(&m, NodeKind::Tag).is_empty());
    }

    #[tokio::test]
    async fn an_empty_vault_builds_an_empty_model() {
        let (_dir, conn) = open_test_index().await;
        let m = build_model(&conn).await.expect("build");
        assert!(m.nodes().is_empty());
        assert!(m.edges().is_empty());
    }
}
