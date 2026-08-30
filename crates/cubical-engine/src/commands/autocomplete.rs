use cubical_ast::note_title;
use cubical_core::vault::links::resolve_target;
use cubical_index::{
    all_file_paths, all_tag_paths, blocks_for_file, files_for_link_query, tag_paths_for_prefix,
};

use crate::api::types::{
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse, LinkAutocompleteRequest,
    LinkAutocompleteResponse, LinkCandidate, ListTagsRequest, ListTagsResponse,
    TagAutocompleteRequest, TagAutocompleteResponse,
};
use crate::commands::open::open_vault_cloned;
use crate::error::CubicalError;
use crate::state::AppState;

const AUTOCOMPLETE_LIMIT: u32 = 50;

pub async fn link_autocomplete(
    state: &AppState,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let paths = files_for_link_query(vault.index(), &req.query, AUTOCOMPLETE_LIMIT).await?;
    let candidates = paths
        .into_iter()
        .map(|path| {
            let title = note_title(&path).to_string();
            LinkCandidate { path, title }
        })
        .collect();
    Ok(LinkAutocompleteResponse { candidates })
}

pub async fn tag_autocomplete(
    state: &AppState,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let candidates = tag_paths_for_prefix(vault.index(), &req.query, AUTOCOMPLETE_LIMIT).await?;
    Ok(TagAutocompleteResponse { candidates })
}

pub async fn list_tags(
    state: &AppState,
    req: ListTagsRequest,
) -> Result<ListTagsResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let tags = all_tag_paths(vault.index()).await?;
    Ok(ListTagsResponse { tags })
}

pub async fn block_id_autocomplete(
    state: &AppState,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let known = all_file_paths(vault.index()).await?;

    let target_path = match resolve_target(req.target_raw.trim(), &known) {
        Some(p) => p,
        None => return Ok(BlockIdAutocompleteResponse { candidates: vec![] }),
    };

    let blocks = blocks_for_file(vault.index(), &target_path).await?;
    let candidates: Vec<String> = blocks
        .into_iter()
        .map(|b| b.block_id)
        .take(AUTOCOMPLETE_LIMIT as usize)
        .collect();
    Ok(BlockIdAutocompleteResponse { candidates })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{replace_tags_for_file, TagRow, TagSource};
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

    async fn seed_file(vault: &Vault, rel: &str, type_id: &str) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES (?1, ?2, 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![rel, type_id],
            )
            .await
            .expect("seed files row");
    }

    fn tag(path: &str, source: TagSource) -> TagRow {
        TagRow {
            tag_path: path.into(),
            source,
        }
    }

    #[tokio::test]
    async fn link_autocomplete_returns_titled_candidates() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "notes/Project Cubical.md", "markdown").await;
        seed_file(&vault, "image.png", "binary").await;

        let resp = link_autocomplete(
            &state,
            LinkAutocompleteRequest {
                vault_id: "v1".into(),
                query: "cub".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.candidates.len(), 1);
        assert_eq!(resp.candidates[0].path, "notes/Project Cubical.md");
        assert_eq!(resp.candidates[0].title, "Project Cubical");
    }

    #[tokio::test]
    async fn tag_autocomplete_returns_prefix_matches() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[
                tag("project", TagSource::Inline),
                tag("done", TagSource::Inline),
            ],
        )
        .await
        .unwrap();

        let resp = tag_autocomplete(
            &state,
            TagAutocompleteRequest {
                vault_id: "v1".into(),
                query: "pro".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.candidates, vec!["project".to_string()]);
    }

    #[tokio::test]
    async fn list_tags_returns_all_distinct_sorted() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        seed_file(&vault, "b.md", "markdown").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[
                tag("project/cubical", TagSource::Inline),
                tag("alpha", TagSource::Inline),
            ],
        )
        .await
        .unwrap();
        replace_tags_for_file(
            vault.index(),
            "b.md",
            &[tag("project/cubical", TagSource::Frontmatter)],
        )
        .await
        .unwrap();

        let resp = list_tags(
            &state,
            ListTagsRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(
            resp.tags,
            vec!["alpha".to_string(), "project/cubical".to_string()]
        );
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = link_autocomplete(
            &state,
            LinkAutocompleteRequest {
                vault_id: "ghost".into(),
                query: "x".into(),
            },
        )
        .await
        .expect_err("vault-not-open");
        assert!(matches!(err, crate::error::CubicalError::VaultNotOpen(v) if v == "ghost"));
    }

    #[tokio::test]
    async fn block_id_autocomplete_returns_ids_for_resolved_target() {
        use cubical_index::{replace_blocks_for_file, BlockRow};
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "notes/Daily.md", "markdown").await;
        replace_blocks_for_file(
            vault.index(),
            "notes/Daily.md",
            &[
                BlockRow {
                    block_id: "intro".into(),
                    position_hint: 0,
                },
                BlockRow {
                    block_id: "summary".into(),
                    position_hint: 10,
                },
            ],
        )
        .await
        .expect("seed blocks");

        for target_raw in ["Daily", "  Daily  "] {
            let resp = block_id_autocomplete(
                &state,
                BlockIdAutocompleteRequest {
                    vault_id: "v1".into(),
                    target_raw: target_raw.into(),
                },
            )
            .await
            .expect("ok");
            assert_eq!(
                resp.candidates,
                vec!["intro".to_string(), "summary".to_string()],
                "target_raw {target_raw:?} names the same file",
            );
        }
    }

    #[tokio::test]
    async fn block_id_autocomplete_empty_when_target_unresolved() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let resp = block_id_autocomplete(
            &state,
            BlockIdAutocompleteRequest {
                vault_id: "v1".into(),
                target_raw: "ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(resp.candidates.is_empty());
    }
}
