use super::{RepairDanglingLinkRequest, RepairDanglingLinkResponse};
use crate::commands::rename::reattach_dangling;
use crate::error::CubicalError;
use crate::events::EventSink;
use crate::state::AppState;

pub async fn repair_dangling_link(
    state: &AppState,
    app: &dyn EventSink,
    req: RepairDanglingLinkRequest,
) -> Result<RepairDanglingLinkResponse, CubicalError> {
    crate::plugins::require(state, &req.vault_id, crate::plugins::Feature::Integrity).await?;

    let target_raw = req.target_raw.trim();
    if target_raw.is_empty() {
        return Err(CubicalError::InvalidRequest("target_raw is empty".into()));
    }

    let done = reattach_dangling(state, app, &req.vault_id, target_raw, &req.to_path).await?;
    Ok(RepairDanglingLinkResponse {
        files_rewritten: done.files_rewritten,
        refs_updated: done.refs_updated,
        pending_count: done.pending_count,
    })
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{drop_file_as_watcher_would, switch, vault_with};
    use super::super::list_dangling_links;
    use super::super::ListDanglingLinksRequest;
    use super::*;
    use crate::events::NoopEventSink;

    async fn dangling_count(state: &AppState) -> usize {
        list_dangling_links(
            state,
            ListDanglingLinksRequest {
                vault_id: "v1".into(),
                limit: None,
            },
        )
        .await
        .expect("ok")
        .groups
        .len()
    }

    #[tokio::test]
    async fn reattaching_rewrites_the_referring_file_on_disk() {
        let (dir, vault, state) = vault_with(&[
            ("src.md", "see [[plan]] twice: [[plan]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/roadmap.md", "---\ntitle: plan\n---\ntwo\n"),
        ])
        .await;
        drop_file_as_watcher_would(&dir, &vault, "notes/plan.md").await;
        assert_eq!(dangling_count(&state).await, 1);

        let resp = repair_dangling_link(
            &state,
            &NoopEventSink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "plan".into(),
                to_path: "archive/roadmap.md".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.files_rewritten, 1);
        assert_eq!(resp.pending_count, 0);
        let on_disk = std::fs::read_to_string(dir.path().join("src.md")).unwrap();
        assert_eq!(on_disk, "see [[roadmap]] twice: [[roadmap]]\n");
        assert_eq!(dangling_count(&state).await, 0);
    }

    struct Recorded(std::sync::Mutex<Vec<crate::events::AppEvent>>);

    impl EventSink for Recorded {
        fn emit(&self, event: crate::events::AppEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[tokio::test]
    async fn a_repair_reports_through_the_rename_flush_events() {
        use crate::events::AppEvent;
        let (dir, vault, state) = vault_with(&[
            ("src.md", "see [[plan]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/roadmap.md", "two\n"),
        ])
        .await;
        drop_file_as_watcher_would(&dir, &vault, "notes/plan.md").await;
        let sink = Recorded(std::sync::Mutex::default());

        repair_dangling_link(
            &state,
            &sink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "plan".into(),
                to_path: "archive/roadmap.md".into(),
            },
        )
        .await
        .expect("ok");

        let events = sink.0.into_inner().unwrap();
        let [AppEvent::FlushComplete(done), AppEvent::PendingRewritesChanged(pending)] =
            events.as_slice()
        else {
            panic!("a repair emits exactly rename's flush-complete then pending-changed");
        };
        assert_eq!(
            (
                done.vault_id.as_str(),
                done.files_rewritten,
                done.refs_updated
            ),
            ("v1", 1, 1)
        );
        assert_eq!((pending.vault_id.as_str(), pending.count), ("v1", 0));
    }

    #[tokio::test]
    async fn reattaching_an_ambiguous_token_writes_the_disambiguating_path_form() {
        let (dir, _vault, state) = vault_with(&[
            ("src.md", "see [[plan]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/plan.md", "two\n"),
        ])
        .await;

        repair_dangling_link(
            &state,
            &NoopEventSink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "plan".into(),
                to_path: "notes/plan.md".into(),
            },
        )
        .await
        .expect("ok");

        let on_disk = std::fs::read_to_string(dir.path().join("src.md")).unwrap();
        assert_eq!(on_disk, "see [[notes/plan]]\n");
        assert_eq!(dangling_count(&state).await, 0);
    }

    #[tokio::test]
    async fn a_resolvable_link_is_left_alone() {
        let (dir, _vault, state) =
            vault_with(&[("src.md", "see [[plan]]\n"), ("notes/plan.md", "one\n")]).await;

        let resp = repair_dangling_link(
            &state,
            &NoopEventSink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "plan".into(),
                to_path: "notes/plan.md".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.files_rewritten, 0);
        assert_eq!(resp.refs_updated, 0);
        let on_disk = std::fs::read_to_string(dir.path().join("src.md")).unwrap();
        assert_eq!(on_disk, "see [[plan]]\n");
    }

    #[tokio::test]
    async fn untracked_destination_is_rejected() {
        let (_dir, _vault, state) = vault_with(&[("src.md", "see [[plan]]\n")]).await;

        let err = repair_dangling_link(
            &state,
            &NoopEventSink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "plan".into(),
                to_path: "archive/ghost.md".into(),
            },
        )
        .await
        .expect_err("should be FileNotFound");
        assert!(matches!(err, CubicalError::FileNotFound(p) if p == "archive/ghost.md"));
    }

    #[tokio::test]
    async fn an_empty_token_is_rejected() {
        let (_dir, _vault, state) = vault_with(&[("src.md", "hi\n")]).await;

        let err = repair_dangling_link(
            &state,
            &NoopEventSink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "   ".into(),
                to_path: "src.md".into(),
            },
        )
        .await
        .expect_err("should be InvalidRequest");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn a_repair_is_refused_while_the_integrity_plugin_is_off() {
        let (dir, vault, state) = vault_with(&[
            ("src.md", "see [[plan]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/roadmap.md", "two\n"),
        ])
        .await;
        drop_file_as_watcher_would(&dir, &vault, "notes/plan.md").await;
        switch(&state, "plugins.integrity_enabled", false).await;

        let err = repair_dangling_link(
            &state,
            &NoopEventSink,
            RepairDanglingLinkRequest {
                vault_id: "v1".into(),
                target_raw: "plan".into(),
                to_path: "archive/roadmap.md".into(),
            },
        )
        .await
        .expect_err("a switched-off plugin must not rewrite files");

        assert!(matches!(err, CubicalError::FeatureDisabled(id) if id == "integrity"));
        let on_disk = std::fs::read_to_string(dir.path().join("src.md")).unwrap();
        assert_eq!(on_disk, "see [[plan]]\n", "a refusal writes nothing");
    }
}
