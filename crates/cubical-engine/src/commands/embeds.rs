use cubical_core::vault::embeds::{extract_block, extract_section, strip_frontmatter};
use cubical_core::vault::links::{read_source_off_executor, resolve_target};
use cubical_core::vault::pending::materialize_on_read;
use cubical_index::blocks_for_file;

use crate::api::types::{EmbedKind, GetEmbedRequest, GetEmbedResponse, ResolvedAnchor};
use crate::commands::links::split_target_anchor;
use crate::error::CubicalError;
use crate::state::AppState;

pub async fn get_embed(
    state: &AppState,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let vault = open.vault.clone();
    drop(guard);

    let conn = vault.index().connection();
    let mut rows = conn
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut known: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        known.push(row.get(0)?);
    }

    let (target, anchor) = split_target_anchor(&req.target_raw);
    let Some(target_path) = resolve_target(&target, &known) else {
        return Ok(GetEmbedResponse {
            kind: EmbedKind::Unresolved,
            target_path: None,
            content: None,
        });
    };

    let abs = vault.root().join(&target_path);
    let Some(on_disk) = read_source_off_executor(&abs).await else {
        return Ok(GetEmbedResponse {
            kind: EmbedKind::Unresolved,
            target_path: Some(target_path),
            content: None,
        });
    };

    let source = materialize_on_read(vault.index(), &target_path, &on_disk).await?;

    match anchor {
        None => Ok(GetEmbedResponse {
            kind: EmbedKind::Note,
            target_path: Some(target_path),
            content: Some(strip_frontmatter(&source).to_string()),
        }),
        Some(ResolvedAnchor::Heading { value }) => match extract_section(&source, &value) {
            Some(content) => Ok(GetEmbedResponse {
                kind: EmbedKind::Section,
                target_path: Some(target_path),
                content: Some(content),
            }),
            None => Ok(GetEmbedResponse {
                kind: EmbedKind::MissingAnchor,
                target_path: Some(target_path),
                content: None,
            }),
        },
        Some(ResolvedAnchor::Block { value }) => {
            let blocks = blocks_for_file(vault.index(), &target_path).await?;
            match blocks.into_iter().find(|b| b.block_id == value) {
                Some(b) => Ok(GetEmbedResponse {
                    kind: EmbedKind::Block,
                    target_path: Some(target_path),
                    content: Some(extract_block(&source, b.position_hint)),
                }),
                None => Ok(GetEmbedResponse {
                    kind: EmbedKind::MissingAnchor,
                    target_path: Some(target_path),
                    content: None,
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{replace_blocks_for_file, BlockRow};
    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    async fn state_with_vault_at(dir: &std::path::Path, vault_id: &str) -> (Vault, AppState) {
        let vault = Vault::open(dir).await.expect("open");
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
        (vault, state)
    }

    async fn scan(vault: &Vault) {
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
    }

    #[tokio::test]
    async fn get_embed_full_note_strips_frontmatter() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Daily.md"), "---\nk: v\n---\nbody text\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Daily".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Note));
        assert_eq!(resp.target_path.as_deref(), Some("Daily.md"));
        assert_eq!(resp.content.as_deref(), Some("body text\n"));
    }

    #[tokio::test]
    async fn get_embed_section_returns_heading_slice() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("Notes.md"),
            "# Intro\nhello\n# Other\nignored\n",
        )
        .unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes#Intro".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Section));
        assert_eq!(resp.content.as_deref(), Some("hello\n"));
    }

    #[tokio::test]
    async fn get_embed_block_returns_paragraph_via_blocks_for_file() {
        let dir = tempdir().unwrap();
        let src = "para one\nstill para ^xyz\n\nnext\n";
        std::fs::write(dir.path().join("Notes.md"), src).unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;
        replace_blocks_for_file(
            vault.index(),
            "Notes.md",
            &[BlockRow {
                block_id: "xyz".into(),
                position_hint: src.find("still para").unwrap() as u64,
            }],
        )
        .await
        .expect("seed blocks");

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes#^xyz".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Block));
        assert_eq!(resp.content.as_deref(), Some("para one\nstill para ^xyz\n"),);
    }

    #[tokio::test]
    async fn get_embed_unresolved_target_returns_unresolved() {
        let dir = tempdir().unwrap();
        let (_vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Unresolved));
        assert!(resp.target_path.is_none());
        assert!(resp.content.is_none());
    }

    #[tokio::test]
    async fn get_embed_materializes_pending_rewrites_in_body() {
        use cubical_index::{enqueue_pending, NewPendingRewrite, RewriteKind};
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Notes.md"), "body referencing [[Daily]]\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Notes.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "Daily".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Note));
        assert_eq!(
            resp.content.as_deref(),
            Some("body referencing [[Journal]]\n"),
        );
    }

    #[tokio::test]
    async fn get_embed_missing_heading_returns_missing_anchor() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Notes.md"), "# Real\nbody\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes#Ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::MissingAnchor));
        assert_eq!(resp.target_path.as_deref(), Some("Notes.md"));
        assert!(resp.content.is_none());
    }
}
