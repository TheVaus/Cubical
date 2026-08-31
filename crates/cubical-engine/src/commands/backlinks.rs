use cubical_core::vault::pending::materialize_on_read;
use cubical_index::backlinks_for;

use crate::api::types::{Backlink, GetBacklinksRequest, GetBacklinksResponse};
use crate::commands::open::open_vault_cloned;
use crate::commands::snippet::build_snippet;
use crate::error::CubicalError;
use crate::state::AppState;

pub async fn get_backlinks(
    state: &AppState,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;

    let rows = backlinks_for(vault.index(), &req.path).await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let abs = vault.root().join(&row.source_path);
        let read = tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs))
            .await
            .map_err(|e| CubicalError::Io(format!("backlink read join error: {e}")))?;
        let context = match read {
            Ok(raw) => {
                let text = materialize_on_read(vault.index(), &row.source_path, &raw)
                    .await
                    .unwrap_or(raw);
                build_snippet(&text, row.position)
            }
            Err(e) => {
                tracing::debug!(
                    path = %row.source_path,
                    error = %e,
                    "get_backlinks: source read failed; snippet will be empty",
                );
                String::new()
            }
        };
        out.push(Backlink {
            source_path: row.source_path,
            context,
            position: row.position,
        });
    }

    Ok(GetBacklinksResponse { backlinks: out })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::api::types::GetBacklinksRequest;
    use crate::error::CubicalError;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{replace_links_for_file, LinkRow};
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
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

    async fn seed_md(vault: &Vault, rel: &str, body: &str) {
        let abs = vault.root().join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&abs, body).expect("write");
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

    fn link_at(target_raw: &str, target_path: &str, position: u64) -> LinkRow {
        LinkRow {
            target_raw: target_raw.into(),
            target_path: Some(target_path.into()),
            anchor_kind: None,
            anchor_value: None,
            display_text: None,
            is_embed: false,
            position,
        }
    }

    #[tokio::test]
    async fn get_backlinks_returns_empty_when_no_links_point_here() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "lonely.md", "no links here").await;

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "lonely.md".into(),
            },
        )
        .await
        .expect("ok");
        assert!(resp.backlinks.is_empty());
    }

    #[tokio::test]
    async fn get_backlinks_snippet_reflects_pending_rewrites() {
        use cubical_index::{enqueue_pending, NewPendingRewrite, RewriteKind};
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "Note.md", "target\n").await;
        seed_md(&vault, "Ref.md", "see [[a]]\n").await;
        let materialized = "see [[Journal]]\n";
        let pos = materialized.find("[[").unwrap() as u64;
        replace_links_for_file(vault.index(), "Ref.md", &[link_at("a", "Note.md", pos)])
            .await
            .unwrap();
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Ref.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "a".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "Note.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 1);
        assert!(
            resp.backlinks[0].context.contains("Journal"),
            "snippet must reflect the materialized link, got {:?}",
            resp.backlinks[0].context,
        );
    }

    #[tokio::test]
    async fn get_backlinks_returns_one_row_per_link_with_snippet() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(
            &vault,
            "source.md",
            "Some preamble before the link [[target]] and trailing text.",
        )
        .await;
        seed_md(&vault, "target.md", "body").await;

        let conn = vault.index();
        let pos = "Some preamble before the link ".len() as u64;
        replace_links_for_file(conn, "source.md", &[link_at("target", "target.md", pos)])
            .await
            .expect("seed links");

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "target.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 1);
        let b = &resp.backlinks[0];
        assert_eq!(b.source_path, "source.md");
        assert_eq!(b.position, pos);
        assert!(b.context.contains("link"), "context: {}", b.context);
        assert!(!b.context.contains('\n'));
    }

    #[tokio::test]
    async fn get_backlinks_lists_multiple_sources_ordered() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "a.md", "first link [[target]] here").await;
        seed_md(&vault, "b.md", "[[target]] at start").await;
        seed_md(&vault, "target.md", "body").await;

        let conn = vault.index();
        replace_links_for_file(conn, "a.md", &[link_at("target", "target.md", 11)])
            .await
            .expect("a");
        replace_links_for_file(conn, "b.md", &[link_at("target", "target.md", 0)])
            .await
            .expect("b");

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "target.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 2);
        assert_eq!(resp.backlinks[0].source_path, "a.md");
        assert_eq!(resp.backlinks[1].source_path, "b.md");
    }

    #[tokio::test]
    async fn get_backlinks_missing_source_file_returns_empty_context_not_error() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES ('ghost.md', 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                (),
            )
            .await
            .expect("seed ghost row");
        seed_md(&vault, "target.md", "body").await;

        let conn = vault.index();
        replace_links_for_file(conn, "ghost.md", &[link_at("target", "target.md", 0)])
            .await
            .expect("links");

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "target.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 1);
        assert_eq!(resp.backlinks[0].source_path, "ghost.md");
        assert_eq!(resp.backlinks[0].context, "");
    }

    #[tokio::test]
    async fn get_backlinks_unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "ghost".into(),
                path: "anything".into(),
            },
        )
        .await
        .expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
