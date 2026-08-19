use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Note,
    Attachment,
    Ghost,
    Tag,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    Link,
    Embed,
    Ghost,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: NodeId,
    pub kind: NodeKind,
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphModel {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    adjacency: Vec<Vec<NodeId>>,
}

impl GraphModel {
    pub fn new(nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Self {
        let mut adjacency = vec![Vec::new(); nodes.len()];
        for e in &edges {
            let s = e.source.0 as usize;
            let t = e.target.0 as usize;
            if s < adjacency.len() && t < adjacency.len() {
                adjacency[s].push(e.target);
                adjacency[t].push(e.source);
            }
        }
        Self {
            nodes,
            edges,
            adjacency,
        }
    }

    pub fn nodes(&self) -> &[GraphNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[GraphEdge] {
        &self.edges
    }

    pub fn neighbours(&self, id: NodeId) -> &[NodeId] {
        self.adjacency.get(id.0 as usize).map_or(&[], Vec::as_slice)
    }

    pub fn degree(&self, id: NodeId) -> usize {
        self.neighbours(id).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> GraphModel {
        GraphModel::new(
            vec![
                GraphNode {
                    id: NodeId(0),
                    kind: NodeKind::Note,
                    key: "a.md".into(),
                    label: "a".into(),
                },
                GraphNode {
                    id: NodeId(1),
                    kind: NodeKind::Note,
                    key: "b.md".into(),
                    label: "b".into(),
                },
                GraphNode {
                    id: NodeId(2),
                    kind: NodeKind::Tag,
                    key: "work".into(),
                    label: "work".into(),
                },
            ],
            vec![
                GraphEdge {
                    source: NodeId(0),
                    target: NodeId(1),
                    kind: EdgeKind::Link,
                },
                GraphEdge {
                    source: NodeId(0),
                    target: NodeId(2),
                    kind: EdgeKind::Tag,
                },
            ],
        )
    }

    #[test]
    fn degree_counts_both_directions() {
        let m = model();
        assert_eq!(m.degree(NodeId(0)), 2);
        assert_eq!(m.degree(NodeId(1)), 1);
        assert_eq!(m.degree(NodeId(2)), 1);
    }

    #[test]
    fn neighbours_are_undirected() {
        let m = model();
        assert_eq!(m.neighbours(NodeId(1)), &[NodeId(0)]);
        assert_eq!(m.neighbours(NodeId(0)), &[NodeId(1), NodeId(2)]);
    }

    #[test]
    fn isolated_node_has_no_neighbours() {
        let m = GraphModel::new(
            vec![GraphNode {
                id: NodeId(0),
                kind: NodeKind::Note,
                key: "x.md".into(),
                label: "x".into(),
            }],
            vec![],
        );
        assert_eq!(m.degree(NodeId(0)), 0);
        assert!(m.neighbours(NodeId(0)).is_empty());
    }
}
