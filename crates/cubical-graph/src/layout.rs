use crate::model::{GraphModel, NodeId};
use crate::quadtree::Quadtree;

pub type Positions = Vec<(f32, f32)>;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutParams {
    pub iterations: u32,
    pub seed: u64,
    pub theta: f32,
    pub area: f32,
    pub gravity: f32,
}

impl Default for LayoutParams {
    fn default() -> Self {
        Self {
            iterations: 300,
            seed: 1,
            theta: 0.8,
            area: 1_000_000.0,
            gravity: 0.02,
        }
    }
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1))
    }

    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32) / ((1u32 << 24) as f32)
    }
}

pub fn layout(model: &GraphModel, params: &LayoutParams) -> Positions {
    let n = model.nodes().len();
    if n == 0 {
        return Vec::new();
    }
    let mut rng = Rng::new(params.seed);
    let span = params.area.sqrt();
    let mut pos: Positions = (0..n)
        .map(|_| ((rng.next_f32() - 0.5) * span, (rng.next_f32() - 0.5) * span))
        .collect();
    let k = (params.area / n as f32).sqrt();
    let mut temperature = span / 10.0;
    let cooling = temperature / (params.iterations as f32 + 1.0);

    for _ in 0..params.iterations {
        let tree = Quadtree::build(&pos);
        let mut disp = vec![(0.0f32, 0.0f32); n];

        for (i, d) in disp.iter_mut().enumerate() {
            let (rx, ry) = tree.repulsion(pos[i], params.theta, k);
            d.0 += rx;
            d.1 += ry;
            d.0 -= pos[i].0 * params.gravity * k;
            d.1 -= pos[i].1 * params.gravity * k;
        }

        for e in model.edges() {
            let s = e.source.0 as usize;
            let t = e.target.0 as usize;
            if s >= n || t >= n {
                continue;
            }
            let dx = pos[s].0 - pos[t].0;
            let dy = pos[s].1 - pos[t].1;
            let d = (dx * dx + dy * dy).sqrt();
            if d < 1e-3 {
                continue;
            }
            let f = d * d / k;
            let ux = dx / d * f;
            let uy = dy / d * f;
            disp[s].0 -= ux;
            disp[s].1 -= uy;
            disp[t].0 += ux;
            disp[t].1 += uy;
        }

        for i in 0..n {
            let (dx, dy) = disp[i];
            let d = (dx * dx + dy * dy).sqrt();
            if d < 1e-6 {
                continue;
            }
            let limit = d.min(temperature);
            pos[i].0 += dx / d * limit;
            pos[i].1 += dy / d * limit;
        }

        temperature = (temperature - cooling).max(0.0);
    }

    pos
}

pub fn position_of(pos: &Positions, id: NodeId) -> Option<(f32, f32)> {
    pos.get(id.0 as usize).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EdgeKind, GraphEdge, GraphNode, NodeKind};

    fn node(i: u32) -> GraphNode {
        GraphNode {
            id: NodeId(i),
            kind: NodeKind::Note,
            key: format!("n{i}.md"),
            label: format!("n{i}"),
        }
    }

    fn two_clusters() -> GraphModel {
        let nodes: Vec<GraphNode> = (0..6).map(node).collect();
        let edges = vec![
            GraphEdge {
                source: NodeId(0),
                target: NodeId(1),
                kind: EdgeKind::Link,
            },
            GraphEdge {
                source: NodeId(1),
                target: NodeId(2),
                kind: EdgeKind::Link,
            },
            GraphEdge {
                source: NodeId(2),
                target: NodeId(0),
                kind: EdgeKind::Link,
            },
            GraphEdge {
                source: NodeId(3),
                target: NodeId(4),
                kind: EdgeKind::Link,
            },
            GraphEdge {
                source: NodeId(4),
                target: NodeId(5),
                kind: EdgeKind::Link,
            },
            GraphEdge {
                source: NodeId(5),
                target: NodeId(3),
                kind: EdgeKind::Link,
            },
        ];
        GraphModel::new(nodes, edges)
    }

    fn dist(p: &Positions, a: usize, b: usize) -> f32 {
        let dx = p[a].0 - p[b].0;
        let dy = p[a].1 - p[b].1;
        (dx * dx + dy * dy).sqrt()
    }

    #[test]
    fn the_same_seed_gives_identical_positions() {
        let m = two_clusters();
        let p = LayoutParams::default();
        assert_eq!(layout(&m, &p), layout(&m, &p));
    }

    #[test]
    fn a_different_seed_gives_different_positions() {
        let m = two_clusters();
        let a = LayoutParams::default();
        let b = LayoutParams {
            seed: 99,
            ..LayoutParams::default()
        };
        assert_ne!(layout(&m, &a), layout(&m, &b));
    }

    #[test]
    fn connected_nodes_end_closer_than_unconnected_ones() {
        let m = two_clusters();
        let p = layout(&m, &LayoutParams::default());
        let within = dist(&p, 0, 1);
        let across = dist(&p, 0, 3);
        assert!(
            across > within,
            "across {across} should exceed within {within}"
        );
    }

    #[test]
    fn every_position_is_finite() {
        let m = two_clusters();
        let p = layout(&m, &LayoutParams::default());
        assert!(p.iter().all(|(x, y)| x.is_finite() && y.is_finite()));
    }

    #[test]
    fn an_empty_model_lays_out_to_no_positions() {
        let m = GraphModel::new(vec![], vec![]);
        assert!(layout(&m, &LayoutParams::default()).is_empty());
    }

    #[test]
    fn a_single_node_does_not_move_to_nan() {
        let m = GraphModel::new(vec![node(0)], vec![]);
        let p = layout(&m, &LayoutParams::default());
        assert_eq!(p.len(), 1);
        assert!(p[0].0.is_finite() && p[0].1.is_finite());
    }
}
