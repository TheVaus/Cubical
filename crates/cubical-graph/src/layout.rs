use crate::error::GraphError;
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
        let state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        Self(if state == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            state
        })
    }

    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32) / ((1u32 << 24) as f32)
    }
}

pub fn layout(model: &GraphModel, params: &LayoutParams) -> Positions {
    layout_streaming(model, params, 0, &mut |_, _| {}, &|| false).unwrap_or_default()
}

pub fn layout_streaming(
    model: &GraphModel,
    params: &LayoutParams,
    every: u32,
    on_frame: &mut dyn FnMut(u32, &Positions),
    cancelled: &dyn Fn() -> bool,
) -> Result<Positions, GraphError> {
    let n = model.nodes().len();
    if n == 0 {
        return Ok(Vec::new());
    }
    let mut rng = Rng::new(params.seed);
    let span = params.area.sqrt();
    let mut pos: Positions = (0..n)
        .map(|_| ((rng.next_f32() - 0.5) * span, (rng.next_f32() - 0.5) * span))
        .collect();
    let k = (params.area / n as f32).sqrt();
    let mut temperature = span / 10.0;
    let cooling = temperature / (params.iterations as f32 + 1.0);

    for iteration in 1..=params.iterations {
        if cancelled() {
            return Err(GraphError::Cancelled);
        }
        step(
            model,
            &mut pos,
            k,
            temperature,
            params.theta,
            params.gravity,
        );
        temperature = (temperature - cooling).max(0.0);
        if every > 0 && iteration % every == 0 {
            on_frame(iteration, &pos);
        }
    }

    Ok(pos)
}

fn step(
    model: &GraphModel,
    pos: &mut Positions,
    k: f32,
    temperature: f32,
    theta: f32,
    gravity: f32,
) {
    let n = pos.len();
    let tree = Quadtree::build(pos);
    let mut disp = vec![(0.0f32, 0.0f32); n];

    for (i, d) in disp.iter_mut().enumerate() {
        let (rx, ry) = tree.repulsion(pos[i], theta, k);
        d.0 += rx;
        d.1 += ry;
        d.0 -= pos[i].0 * gravity * k;
        d.1 -= pos[i].1 * gravity * k;
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

    #[test]
    fn streaming_emits_frames_at_the_requested_interval() {
        let m = two_clusters();
        let params = LayoutParams {
            iterations: 100,
            ..LayoutParams::default()
        };
        let mut seen: Vec<u32> = Vec::new();
        let out =
            layout_streaming(&m, &params, 10, &mut |i, _| seen.push(i), &|| false).expect("layout");
        assert_eq!(seen.len(), 10);
        assert_eq!(seen.first().copied(), Some(10));
        assert_eq!(seen.last().copied(), Some(100));
        assert_eq!(out.len(), 6);
    }

    #[test]
    fn streaming_matches_the_non_streaming_result() {
        let m = two_clusters();
        let params = LayoutParams::default();
        let streamed =
            layout_streaming(&m, &params, 10, &mut |_, _| {}, &|| false).expect("layout");
        assert_eq!(streamed, layout(&m, &params));
    }

    #[test]
    fn cancellation_stops_the_simulation() {
        let m = two_clusters();
        let params = LayoutParams {
            iterations: 1_000_000,
            ..LayoutParams::default()
        };
        let err = layout_streaming(&m, &params, 1, &mut |_, _| {}, &|| true).unwrap_err();
        assert!(matches!(err, GraphError::Cancelled));
    }

    #[test]
    fn frames_carry_the_positions_at_that_iteration() {
        let m = two_clusters();
        let params = LayoutParams {
            iterations: 20,
            ..LayoutParams::default()
        };
        let mut lengths: Vec<usize> = Vec::new();
        layout_streaming(&m, &params, 10, &mut |_, p| lengths.push(p.len()), &|| {
            false
        })
        .expect("layout");
        assert_eq!(lengths, vec![6, 6]);
    }
}
