use std::time::Instant;

use cubical_graph::{
    layout, EdgeKind, GraphEdge, GraphModel, GraphNode, LayoutParams, NodeId, NodeKind,
};

fn fixture(n: u32) -> GraphModel {
    let nodes: Vec<GraphNode> = (0..n)
        .map(|i| GraphNode {
            id: NodeId(i),
            kind: NodeKind::Note,
            key: format!("note-{i}.md"),
            label: format!("note-{i}"),
        })
        .collect();
    let mut edges = Vec::new();
    for i in 0..n {
        for step in [1u32, 7, 53] {
            let t = (i + step) % n;
            if t != i {
                edges.push(GraphEdge {
                    source: NodeId(i),
                    target: NodeId(t),
                    kind: EdgeKind::Link,
                });
            }
        }
    }
    GraphModel::new(nodes, edges)
}

fn main() {
    let n: u32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(10_000);
    let model = fixture(n);
    println!(
        "nodes: {} edges: {}",
        model.nodes().len(),
        model.edges().len()
    );
    let start = Instant::now();
    let pos = layout(&model, &LayoutParams::default());
    let elapsed = start.elapsed();
    println!(
        "laid out {} nodes in {:.2}s",
        pos.len(),
        elapsed.as_secs_f64()
    );
}
