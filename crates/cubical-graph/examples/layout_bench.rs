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

fn median(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n == 0 {
        return (0.0, 0.0, 0.0);
    }
    let mid = if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    };
    (v[0], mid, v[n - 1])
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(10_000);
    let runs: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(1).max(1);

    let model = fixture(n);
    println!(
        "nodes: {} edges: {}",
        model.nodes().len(),
        model.edges().len()
    );

    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let start = Instant::now();
        let pos = layout(&model, &LayoutParams::default());
        let elapsed = start.elapsed().as_secs_f64();
        println!("laid out {} nodes in {:.2}s", pos.len(), elapsed);
        times.push(elapsed);
    }

    let (lo, mid, hi) = median(times);
    println!("--- layout, {n} nodes, {runs} runs ---");
    println!("layout    : min {lo:.2} s / median {mid:.2} s / max {hi:.2} s");
}
