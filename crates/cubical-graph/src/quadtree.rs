const MAX_DEPTH: u32 = 24;

struct Node {
    cx: f32,
    cy: f32,
    count: u32,
    point: Option<(f32, f32)>,
    half: f32,
    centre_x: f32,
    centre_y: f32,
    children: Option<[usize; 4]>,
}

pub struct Quadtree {
    nodes: Vec<Node>,
}

impl Quadtree {
    pub fn build(points: &[(f32, f32)]) -> Self {
        if points.is_empty() {
            return Self { nodes: Vec::new() };
        }
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for &(x, y) in points {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let centre_x = (min_x + max_x) / 2.0;
        let centre_y = (min_y + max_y) / 2.0;
        let half = ((max_x - min_x).max(max_y - min_y) / 2.0).max(1.0);
        let mut tree = Self {
            nodes: vec![Node {
                cx: 0.0,
                cy: 0.0,
                count: 0,
                point: None,
                half,
                centre_x,
                centre_y,
                children: None,
            }],
        };
        for &p in points {
            tree.insert(0, p, 0);
        }
        tree.finish(0);
        tree
    }

    fn quadrant(&self, at: usize, p: (f32, f32)) -> usize {
        let n = &self.nodes[at];
        usize::from(p.0 >= n.centre_x) + 2 * usize::from(p.1 >= n.centre_y)
    }

    fn subdivide(&mut self, at: usize) {
        let (half, cx, cy) = {
            let n = &self.nodes[at];
            (n.half / 2.0, n.centre_x, n.centre_y)
        };
        let mut ids = [0usize; 4];
        for (q, id) in ids.iter_mut().enumerate() {
            let ox = if q % 2 == 0 { -half } else { half };
            let oy = if q < 2 { -half } else { half };
            *id = self.nodes.len();
            self.nodes.push(Node {
                cx: 0.0,
                cy: 0.0,
                count: 0,
                point: None,
                half,
                centre_x: cx + ox,
                centre_y: cy + oy,
                children: None,
            });
        }
        self.nodes[at].children = Some(ids);
    }

    fn insert(&mut self, at: usize, p: (f32, f32), depth: u32) {
        self.nodes[at].cx += p.0;
        self.nodes[at].cy += p.1;
        self.nodes[at].count += 1;
        if depth >= MAX_DEPTH {
            return;
        }
        if self.nodes[at].count == 1 {
            self.nodes[at].point = Some(p);
            return;
        }
        if self.nodes[at].children.is_none() {
            self.subdivide(at);
            if let Some(existing) = self.nodes[at].point.take() {
                let q = self.quadrant(at, existing);
                if let Some(children) = self.nodes[at].children {
                    self.insert(children[q], existing, depth + 1);
                }
            }
        }
        let q = self.quadrant(at, p);
        let Some(children) = self.nodes[at].children else {
            return;
        };
        self.insert(children[q], p, depth + 1);
    }

    fn finish(&mut self, at: usize) {
        let count = self.nodes[at].count as f32;
        if count > 0.0 {
            self.nodes[at].cx /= count;
            self.nodes[at].cy /= count;
        }
        if let Some(children) = self.nodes[at].children {
            for c in children {
                self.finish(c);
            }
        }
    }

    pub fn repulsion(&self, at: (f32, f32), theta: f32, k: f32) -> (f32, f32) {
        if self.nodes.is_empty() {
            return (0.0, 0.0);
        }
        let mut acc = (0.0, 0.0);
        self.accumulate(0, at, theta, k, &mut acc);
        acc
    }

    fn accumulate(&self, at: usize, p: (f32, f32), theta: f32, k: f32, acc: &mut (f32, f32)) {
        let n = &self.nodes[at];
        if n.count == 0 {
            return;
        }
        let dx = p.0 - n.cx;
        let dy = p.1 - n.cy;
        let d2 = dx * dx + dy * dy;
        let d = d2.sqrt();
        let far = d > 0.0 && (n.half * 2.0) / d < theta;
        match n.children {
            Some(children) if !far => {
                for c in children {
                    self.accumulate(c, p, theta, k, acc);
                }
            }
            _ => {
                if d < 1e-3 {
                    return;
                }
                let f = k * k / d * n.count as f32;
                acc.0 += dx / d * f;
                acc.1 += dy / d * f;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_repulsion(points: &[(f32, f32)], at: (f32, f32), k: f32) -> (f32, f32) {
        let mut fx = 0.0;
        let mut fy = 0.0;
        for p in points {
            let dx = at.0 - p.0;
            let dy = at.1 - p.1;
            let d2 = dx * dx + dy * dy;
            if d2 < 1e-6 {
                continue;
            }
            let d = d2.sqrt();
            let f = k * k / d;
            fx += dx / d * f;
            fy += dy / d * f;
        }
        (fx, fy)
    }

    #[test]
    fn theta_zero_matches_exact_summation() {
        let points: Vec<(f32, f32)> = (0..64)
            .map(|i| ((i % 8) as f32 * 10.0, (i / 8) as f32 * 10.0))
            .collect();
        let tree = Quadtree::build(&points);
        let at = (5.0, 5.0);
        let (ax, ay) = tree.repulsion(at, 0.0, 1.0);
        let (ex, ey) = exact_repulsion(&points, at, 1.0);
        assert!((ax - ex).abs() < 0.05, "fx {ax} vs {ex}");
        assert!((ay - ey).abs() < 0.05, "fy {ay} vs {ey}");
    }

    #[test]
    fn approximation_stays_close_at_theta_point_five() {
        let points: Vec<(f32, f32)> = (0..256)
            .map(|i| ((i % 16) as f32 * 4.0, (i / 16) as f32 * 4.0))
            .collect();
        let tree = Quadtree::build(&points);
        let at = (100.0, 100.0);
        let (ax, ay) = tree.repulsion(at, 0.5, 1.0);
        let (ex, ey) = exact_repulsion(&points, at, 1.0);
        let err = ((ax - ex).powi(2) + (ay - ey).powi(2)).sqrt();
        let mag = (ex * ex + ey * ey).sqrt().max(1e-6);
        assert!(err / mag < 0.1, "relative error {}", err / mag);
    }

    #[test]
    fn an_empty_tree_exerts_no_force() {
        let tree = Quadtree::build(&[]);
        assert_eq!(tree.repulsion((0.0, 0.0), 0.5, 1.0), (0.0, 0.0));
    }

    #[test]
    fn coincident_points_do_not_produce_nan() {
        let points = vec![(1.0, 1.0); 8];
        let tree = Quadtree::build(&points);
        let (fx, fy) = tree.repulsion((1.0, 1.0), 0.5, 1.0);
        assert!(fx.is_finite() && fy.is_finite());
    }
}
