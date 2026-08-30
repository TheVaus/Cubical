use libsql::params;

use cubical_core::unix_now_secs;
use cubical_index::pending_count_total;

use crate::api::types::{RepairDanglingLinkRequest, RepairDanglingLinkResponse};
use crate::commands::link_match::derive_reattach_token;
use crate::commands::rename::{
    clone_vault_with_flush_state, enqueue_coalesced, flush_pending_for_target, mint_rename_op_id,
    path_tracked,
};
use crate::error::CubicalError;
use crate::events::{
    emit_flush_complete, emit_pending_rewrites_changed, EventSink, VaultFlushComplete,
    VaultPendingRewritesChanged,
};
use crate::state::AppState;

use super::DANGLING_PREDICATE;

pub async fn repair_dangling_link(
    state: &AppState,
    app: &dyn EventSink,
    req: RepairDanglingLinkRequest,
) -> Result<RepairDanglingLinkResponse, CubicalError> {
    let target_raw = req.target_raw.trim().to_string();
    if target_raw.is_empty() {
        return Err(CubicalError::InvalidRequest("target_raw is empty".into()));
    }

    let (vault, flush_own_writes, flush_in_progress) =
        clone_vault_with_flush_state(state, &req.vault_id).await?;
    let conn = vault.index().connection();

    if !path_tracked(conn, &req.to_path).await? {
        return Err(CubicalError::FileNotFound(req.to_path.clone()));
    }

    let referrers = dangling_referrers(conn, &target_raw).await?;
    if referrers.is_empty() {
        return Ok(RepairDanglingLinkResponse {
            files_rewritten: 0,
            refs_updated: 0,
            pending_count: pending_count_total(vault.index()).await?,
        });
    }

    let new_token = derive_reattach_token(&target_raw, &req.to_path);
    let rename_op_id = mint_rename_op_id(&vault).await?;
    let now = unix_now_secs();

    let tx = conn.transaction().await?;
    for source_path in &referrers {
        enqueue_coalesced(
            &tx,
            source_path,
            "wiki_link",
            &target_raw,
            &new_token,
            now,
            rename_op_id,
        )
        .await?;
    }
    let reconnect =
        format!("UPDATE links SET target_path = ?1 WHERE target_raw = ?2 AND {DANGLING_PREDICATE}");
    tx.execute(&reconnect, params![req.to_path.clone(), target_raw.clone()])
        .await?;
    tx.commit().await?;

    let _guard = flush_in_progress.lock().await;
    let mut files_rewritten: i64 = 0;
    let mut refs_updated: i64 = 0;
    for source_path in &referrers {
        let (changed, n) =
            flush_pending_for_target(&vault, source_path, Some(flush_own_writes.clone())).await?;
        if changed {
            files_rewritten += 1;
        }
        refs_updated += n as i64;
    }

    let pending_count = pending_count_total(vault.index()).await?;
    emit_flush_complete(
        app,
        VaultFlushComplete {
            vault_id: req.vault_id.clone(),
            files_rewritten,
            refs_updated,
        },
    );
    emit_pending_rewrites_changed(
        app,
        VaultPendingRewritesChanged {
            vault_id: req.vault_id.clone(),
            count: pending_count,
        },
    );

    Ok(RepairDanglingLinkResponse {
        files_rewritten,
        refs_updated,
        pending_count,
    })
}

async fn dangling_referrers(
    conn: &libsql::Connection,
    target_raw: &str,
) -> Result<Vec<String>, CubicalError> {
    let sql = format!(
        "SELECT DISTINCT source_path FROM links \
         WHERE target_raw = ?1 AND {DANGLING_PREDICATE} \
         ORDER BY source_path"
    );
    let mut rows = conn.query(&sql, params![target_raw]).await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get(0)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{drop_file_as_watcher_would, vault_with};
    use super::super::list_dangling_links;
    use super::*;
    use crate::api::types::ListDanglingLinksRequest;
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
}
