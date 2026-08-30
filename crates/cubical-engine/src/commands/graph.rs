use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use cubical_graph::{
    build_model, layout_streaming, GraphEdge, GraphModel, GraphNode, LayoutParams, NodeId,
};

use crate::api::types::{
    GraphFilter, GraphLayoutRequest, GraphSnapshot, GraphSnapshotRequest, LayoutComplete,
    LayoutFrame,
};
use crate::error::CubicalError;
use crate::state::AppState;

pub const FRAME_INTERVAL: u32 = 10;

#[derive(Default)]
pub struct LayoutRegistry {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl LayoutRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn running(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self, vault_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self
            .running()
            .insert(vault_id.to_string(), Arc::clone(&flag))
        {
            previous.store(true, Ordering::Relaxed);
        }
        flag
    }

    pub fn cancel(&self, vault_id: &str) {
        if let Some(flag) = self.running().remove(vault_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_all(&self) {
        for (_, flag) in self.running().drain() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn finish(&self, vault_id: &str, flag: &Arc<AtomicBool>) {
        let mut running = self.running();
        if running.get(vault_id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            running.remove(vault_id);
        }
    }

    #[cfg(test)]
    fn is_running(&self, vault_id: &str) -> bool {
        self.running().contains_key(vault_id)
    }
}

fn matches(node: &GraphNode, filter: &GraphFilter) -> bool {
    if let Some(kinds) = &filter.kinds {
        if !kinds.contains(&node.kind) {
            return false;
        }
    }
    if let Some(prefix) = &filter.path_prefix {
        if !prefix.is_empty() && !node.key.starts_with(prefix.as_str()) {
            return false;
        }
    }
    true
}

fn apply_filter(model: &GraphModel, filter: &GraphFilter) -> GraphSnapshot {
    let mut remap: HashMap<NodeId, NodeId> = HashMap::new();
    let mut nodes: Vec<GraphNode> = Vec::new();
    for node in model.nodes() {
        if !matches(node, filter) {
            continue;
        }
        let id = NodeId(nodes.len() as u32);
        remap.insert(node.id, id);
        nodes.push(GraphNode { id, ..node.clone() });
    }

    let edges: Vec<GraphEdge> = model
        .edges()
        .iter()
        .filter_map(|e| {
            Some(GraphEdge {
                source: *remap.get(&e.source)?,
                target: *remap.get(&e.target)?,
                kind: e.kind,
            })
        })
        .collect();

    GraphSnapshot { nodes, edges }
}

pub async fn graph_snapshot(
    state: &AppState,
    req: GraphSnapshotRequest,
) -> Result<GraphSnapshot, CubicalError> {
    let vault = crate::commands::open::open_vault_cloned_for(
        state,
        &req.vault_id,
        crate::plugins::Feature::GraphView,
    )
    .await?;

    let model = build_model(vault.index()).await?;
    Ok(apply_filter(&model, &req.filter))
}

pub async fn graph_layout<F>(
    state: &AppState,
    registry: &LayoutRegistry,
    req: GraphLayoutRequest,
    mut on_frame: F,
) -> Result<LayoutComplete, CubicalError>
where
    F: FnMut(LayoutFrame) + Send + 'static,
{
    crate::plugins::require(state, &req.vault_id, crate::plugins::Feature::GraphView).await?;

    let vault_id = req.vault_id.clone();
    let flag = registry.begin(&vault_id);

    let model = GraphModel::new(req.snapshot.nodes, req.snapshot.edges);
    let mut params = LayoutParams::default();
    if let Some(seed) = req.seed {
        params.seed = seed;
    }
    if let Some(iterations) = req.iterations {
        params.iterations = iterations;
    }

    let cancel = Arc::clone(&flag);
    let joined = tokio::task::spawn_blocking(move || {
        let cancelled = || cancel.load(Ordering::Relaxed);
        layout_streaming(
            &model,
            &params,
            FRAME_INTERVAL,
            &mut |iteration, positions| {
                on_frame(LayoutFrame {
                    iteration,
                    positions: flatten(positions),
                })
            },
            &cancelled,
        )
        .map(|positions| LayoutComplete {
            iterations: params.iterations,
            positions: flatten(&positions),
        })
    })
    .await;

    registry.finish(&vault_id, &flag);

    match joined {
        Ok(result) => Ok(result?),
        Err(e) => Err(CubicalError::Io(format!("graph layout join error: {e}"))),
    }
}

fn flatten(positions: &[(f32, f32)]) -> Vec<f32> {
    let mut out = Vec::with_capacity(positions.len() * 2);
    for (x, y) in positions {
        out.push(*x);
        out.push(*y);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::AtomicU32;

    const RUNAWAY: u32 = 50_000;
    use std::time::{Duration, Instant};

    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_graph::{EdgeKind, NodeKind};
    use cubical_index::{replace_links_for_file, LinkRow};
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().expect("tmpdir");
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault.clone(),
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, vault, state)
    }

    async fn state_with_vaults(ids: &[&str]) -> (TempDir, Arc<AppState>) {
        let dir = tempdir().expect("tmpdir");
        let state = AppState::new();
        for id in ids {
            let root = dir.path().join(id);
            std::fs::create_dir_all(&root).expect("mkdir");
            let vault = Vault::open(&root).await.expect("open");
            state.vaults().write().await.insert(
                (*id).to_string(),
                OpenVault::new(
                    vault,
                    CancellationToken::new(),
                    ScanStatusBackend::Complete,
                    None,
                    cubical_core::vault::settings::SettingsMap::new(),
                ),
            );
        }
        (dir, Arc::new(state))
    }

    async fn switch(state: &AppState, vault_id: &str, key: &str, on: bool) {
        let settings = crate::commands::open::with_open_vault(state, vault_id, |open| {
            std::sync::Arc::clone(&open.settings)
        })
        .await
        .expect("vault open");
        settings
            .write()
            .await
            .insert(key.to_string(), serde_json::json!(on));
    }

    async fn seed_md(vault: &Vault, rel: &str) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![rel],
            )
            .await
            .expect("seed files row");
    }

    async fn seed_tag(vault: &Vault, rel: &str, tag: &str) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO tags (file_path, tag_path, source) VALUES (?1, ?2, 'inline')",
                libsql::params![rel, tag],
            )
            .await
            .expect("seed tags row");
    }

    fn link_to(target: &str) -> LinkRow {
        LinkRow {
            target_raw: target.into(),
            target_path: Some(target.into()),
            anchor_kind: None,
            anchor_value: None,
            display_text: None,
            is_embed: false,
            position: 0,
        }
    }

    fn snapshot_request(vault_id: &str, filter: GraphFilter) -> GraphSnapshotRequest {
        GraphSnapshotRequest {
            vault_id: vault_id.to_string(),
            filter,
        }
    }

    #[tokio::test]
    async fn snapshot_returns_the_vaults_nodes_and_edges() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "a.md").await;
        seed_md(&vault, "b.md").await;
        seed_tag(&vault, "a.md", "work").await;
        replace_links_for_file(vault.index(), "a.md", &[link_to("b.md")])
            .await
            .expect("links");

        let snap = graph_snapshot(&state, snapshot_request("v1", GraphFilter::default()))
            .await
            .expect("snapshot");

        assert_eq!(snap.nodes.len(), 3);
        assert_eq!(snap.edges.len(), 2);
    }

    #[tokio::test]
    async fn snapshot_on_an_unopened_vault_is_an_error() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = graph_snapshot(&state, snapshot_request("nope", GraphFilter::default()))
            .await
            .expect_err("should refuse");
        assert!(matches!(err, CubicalError::VaultNotOpen(_)));
    }

    #[tokio::test]
    async fn a_kind_filter_drops_nodes_and_the_edges_that_touched_them() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "a.md").await;
        seed_md(&vault, "b.md").await;
        seed_tag(&vault, "a.md", "work").await;
        replace_links_for_file(vault.index(), "a.md", &[link_to("b.md")])
            .await
            .expect("links");

        let filter = GraphFilter {
            kinds: Some(vec![NodeKind::Note]),
            path_prefix: None,
        };
        let snap = graph_snapshot(&state, snapshot_request("v1", filter))
            .await
            .expect("snapshot");

        assert_eq!(snap.nodes.len(), 2);
        assert_eq!(snap.edges.len(), 1);
        assert!(snap.edges.iter().all(|e| e.kind == EdgeKind::Link));
    }

    #[tokio::test]
    async fn filtered_node_ids_stay_dense_and_index_their_own_positions() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "keep/a.md").await;
        seed_md(&vault, "drop/b.md").await;
        seed_md(&vault, "keep/c.md").await;

        let filter = GraphFilter {
            kinds: None,
            path_prefix: Some("keep/".into()),
        };
        let snap = graph_snapshot(&state, snapshot_request("v1", filter))
            .await
            .expect("snapshot");

        assert_eq!(snap.nodes.len(), 2);
        let ids: Vec<u32> = snap.nodes.iter().map(|n| n.id.0).collect();
        assert_eq!(ids, vec![0, 1]);
    }

    #[tokio::test]
    async fn an_empty_vault_snapshots_to_an_empty_graph() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let snap = graph_snapshot(&state, snapshot_request("v1", GraphFilter::default()))
            .await
            .expect("snapshot");
        assert!(snap.nodes.is_empty());
        assert!(snap.edges.is_empty());
    }

    fn line_snapshot(n: u32) -> GraphSnapshot {
        let nodes: Vec<GraphNode> = (0..n)
            .map(|i| GraphNode {
                id: NodeId(i),
                kind: NodeKind::Note,
                key: format!("n{i}.md"),
                label: format!("n{i}"),
            })
            .collect();
        let edges: Vec<GraphEdge> = (0..n.saturating_sub(1))
            .map(|i| GraphEdge {
                source: NodeId(i),
                target: NodeId(i + 1),
                kind: EdgeKind::Link,
            })
            .collect();
        GraphSnapshot { nodes, edges }
    }

    fn layout_request(vault_id: &str, nodes: u32, iterations: u32) -> GraphLayoutRequest {
        GraphLayoutRequest {
            vault_id: vault_id.to_string(),
            snapshot: line_snapshot(nodes),
            seed: None,
            iterations: Some(iterations),
        }
    }

    #[tokio::test]
    async fn layout_streams_frames_and_completes_with_two_floats_per_node() {
        let (_dir, state) = state_with_vaults(&["v1"]).await;
        let registry = Arc::new(LayoutRegistry::new());
        let frames = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&frames);

        let done = graph_layout(
            &state,
            &registry,
            layout_request("v1", 6, 100),
            move |frame| {
                assert_eq!(frame.positions.len(), 12);
                seen.fetch_add(1, Ordering::Relaxed);
            },
        )
        .await
        .expect("layout");

        assert_eq!(frames.load(Ordering::Relaxed), 100 / FRAME_INTERVAL);
        assert_eq!(done.positions.len(), 12);
        assert_eq!(done.iterations, 100);
    }

    #[tokio::test]
    async fn a_finished_layout_leaves_nothing_registered() {
        let (_dir, state) = state_with_vaults(&["v1"]).await;
        let registry = Arc::new(LayoutRegistry::new());
        graph_layout(&state, &registry, layout_request("v1", 4, 20), |_| {})
            .await
            .expect("layout");
        assert!(!registry.is_running("v1"));
    }

    #[tokio::test]
    async fn cancelling_stops_the_frames_and_returns_promptly() {
        let (_dir, state) = state_with_vaults(&["v1"]).await;
        let registry = Arc::new(LayoutRegistry::new());
        let frames = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&frames);
        let canceller = Arc::clone(&registry);

        let started = Instant::now();
        let err = graph_layout(
            &state,
            &registry,
            layout_request("v1", 200, RUNAWAY),
            move |_| {
                if seen.fetch_add(1, Ordering::Relaxed) == 0 {
                    canceller.cancel("v1");
                }
            },
        )
        .await
        .expect_err("should cancel");
        let elapsed = started.elapsed();

        assert!(matches!(err, CubicalError::LayoutCancelled));
        assert_eq!(
            frames.load(Ordering::Relaxed),
            1,
            "no frame may be emitted after the cancel is observed"
        );
        assert!(elapsed < Duration::from_secs(20), "took {elapsed:?}");
        assert!(!registry.is_running("v1"));
    }

    #[tokio::test]
    async fn cancelling_one_vault_does_not_disturb_another() {
        let (_dir, state) = state_with_vaults(&["v1", "v2"]).await;
        let registry = Arc::new(LayoutRegistry::new());

        let doomed = Arc::clone(&registry);
        let canceller = Arc::clone(&registry);
        let slow_state = Arc::clone(&state);
        let slow_run = tokio::spawn(async move {
            graph_layout(
                &slow_state,
                &doomed,
                layout_request("v1", 200, RUNAWAY),
                move |_| {
                    canceller.cancel("v1");
                },
            )
            .await
        });

        let healthy = Arc::clone(&registry);
        let fast_state = Arc::clone(&state);
        let fast_run = tokio::spawn(async move {
            graph_layout(&fast_state, &healthy, layout_request("v2", 6, 50), |_| {}).await
        });

        let done = fast_run.await.expect("join").expect("v2 layout");
        assert_eq!(done.positions.len(), 12);
        assert_eq!(done.iterations, 50);

        let err = slow_run.await.expect("join").expect_err("v1 cancelled");
        assert!(matches!(err, CubicalError::LayoutCancelled));
        assert!(!registry.is_running("v2"));
    }

    #[tokio::test]
    async fn a_second_layout_on_one_vault_cancels_the_first() {
        let (_dir, state) = state_with_vaults(&["v1"]).await;
        let registry = Arc::new(LayoutRegistry::new());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let first_registry = Arc::clone(&registry);
        let first_state = Arc::clone(&state);
        let mut started = Some(tx);
        let first = tokio::spawn(async move {
            graph_layout(
                &first_state,
                &first_registry,
                layout_request("v1", 200, RUNAWAY),
                move |_| {
                    if let Some(tx) = started.take() {
                        let _ = tx.send(());
                    }
                },
            )
            .await
        });

        rx.await.expect("the first layout reached its first frame");

        graph_layout(&state, &registry, layout_request("v1", 6, 50), |_| {})
            .await
            .expect("second layout");

        let err = first.await.expect("join").expect_err("first cancelled");
        assert!(matches!(err, CubicalError::LayoutCancelled));
    }

    #[tokio::test]
    async fn a_snapshot_is_refused_while_the_graph_plugin_is_off() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        switch(&state, "v1", "plugins.graph_view_enabled", false).await;

        let err = graph_snapshot(&state, snapshot_request("v1", GraphFilter::default()))
            .await
            .expect_err("a switched-off plugin must not be served");

        assert!(matches!(err, CubicalError::FeatureDisabled(id) if id == "graph-view"));
    }

    #[tokio::test]
    async fn a_layout_is_refused_while_the_graph_plugin_is_off() {
        let (_dir, state) = state_with_vaults(&["v1"]).await;
        switch(&state, "v1", "plugins.graph_view_enabled", false).await;
        let registry = Arc::new(LayoutRegistry::new());

        let err = graph_layout(&state, &registry, layout_request("v1", 6, 50), |_| {})
            .await
            .expect_err("a switched-off plugin must not be served");

        assert!(matches!(err, CubicalError::FeatureDisabled(id) if id == "graph-view"));
        assert!(!registry.is_running("v1"), "a refusal registers no work");
    }
}
