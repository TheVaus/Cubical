use cubical_engine::api::types::{
    GraphLayoutCancelRequest, GraphLayoutRequest, GraphSnapshot, GraphSnapshotRequest,
    LayoutComplete, LayoutFrame,
};
use cubical_engine::commands::graph::LayoutRegistry;
use cubical_engine::error::CubicalError;
use cubical_engine::state::AppState;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn graph_snapshot(
    state: tauri::State<'_, AppState>,
    req: GraphSnapshotRequest,
) -> Result<GraphSnapshot, CubicalError> {
    cubical_engine::commands::graph::graph_snapshot(state.inner(), req).await
}

#[tauri::command]
pub async fn graph_layout(
    registry: tauri::State<'_, LayoutRegistry>,
    req: GraphLayoutRequest,
    on_frame: Channel<LayoutFrame>,
) -> Result<LayoutComplete, CubicalError> {
    cubical_engine::commands::graph::graph_layout(registry.inner(), req, move |frame| {
        let _ = on_frame.send(frame);
    })
    .await
}

#[tauri::command]
pub async fn graph_layout_cancel(
    registry: tauri::State<'_, LayoutRegistry>,
    req: GraphLayoutCancelRequest,
) -> Result<(), CubicalError> {
    registry.cancel(&req.vault_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use cubical_engine::api::types::GraphFilter;
    use cubical_engine::api::types::{EdgeKind, NodeKind};
    use cubical_engine::state::{OpenVault, ScanStatusBackend};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    async fn scanned_vault(files: &[(&str, &str)]) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().expect("tmpdir");
        for (rel, body) in files {
            let abs = dir.path().join(rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(&abs, body).expect("write");
        }

        let vault = cubical_core::Vault::open(dir.path()).await.expect("open");
        let (tx, mut rx) = mpsc::channel(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        cubical_core::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
        drain.await.expect("drain");

        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".to_string(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, state)
    }

    async fn snapshot(state: &AppState) -> GraphSnapshot {
        cubical_engine::commands::graph::graph_snapshot(
            state,
            GraphSnapshotRequest {
                vault_id: "v1".into(),
                filter: GraphFilter::default(),
            },
        )
        .await
        .expect("snapshot")
    }

    #[tokio::test]
    async fn a_scanned_vault_snapshots_to_the_expected_nodes_and_edges() {
        let (_dir, state) = scanned_vault(&[
            ("a.md", "links to [[b]] and carries #work\n"),
            ("b.md", "links back to [[a]]\n"),
            ("c.md", "points at [[nowhere-at-all]]\n"),
        ])
        .await;

        let snap = snapshot(&state).await;

        let notes: Vec<&str> = snap
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Note)
            .map(|n| n.key.as_str())
            .collect();
        assert_eq!(notes.len(), 3, "three markdown files, three note nodes");

        let tags: Vec<&str> = snap
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Tag)
            .map(|n| n.key.as_str())
            .collect();
        assert_eq!(tags, vec!["work"]);

        let ghosts = snap
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Ghost)
            .count();
        assert_eq!(ghosts, 1, "the unresolved link becomes one ghost node");

        let links = snap
            .edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Link)
            .count();
        assert_eq!(links, 2, "a->b and b->a");
        assert_eq!(
            snap.edges
                .iter()
                .filter(|e| e.kind == EdgeKind::Ghost)
                .count(),
            1
        );
        assert_eq!(
            snap.edges
                .iter()
                .filter(|e| e.kind == EdgeKind::Tag)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn every_edge_endpoint_indexes_a_node_that_exists() {
        let (_dir, state) = scanned_vault(&[
            ("notes/one.md", "see [[two]] #alpha/beta\n"),
            ("notes/two.md", "see [[one]] and [[missing]]\n"),
        ])
        .await;

        let snap = snapshot(&state).await;
        let count = snap.nodes.len() as u32;
        assert!(snap
            .edges
            .iter()
            .all(|e| e.source.0 < count && e.target.0 < count));
    }
}
