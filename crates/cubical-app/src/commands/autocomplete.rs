//! Pure async handlers for `link_autocomplete` + `tag_autocomplete`.
//!
//! Both are thin: pull the open vault, call the read-only index helper
//! (`files_for_link_query` / `tag_paths_for_prefix`), map to wire types.
//! See `docs/layer-3-spec.md` §2.6 + §8 Session F.

use std::path::Path;

use cubical_core::vault::links::resolve_target;
use cubical_index::{blocks_for_file, files_for_link_query, tag_paths_for_prefix};

use crate::api::types::{
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse, LinkAutocompleteRequest,
    LinkAutocompleteResponse, LinkCandidate, TagAutocompleteRequest, TagAutocompleteResponse,
};
use crate::error::CubicalError;
use crate::state::AppState;

/// Server-side cap on candidates returned per request. Keeps the
/// dropdown responsive and the IPC payload small; the user narrows by
/// typing more, which re-queries.
const AUTOCOMPLETE_LIMIT: u32 = 50;

/// Display title for a candidate: the basename minus `.md`, falling
/// back to the full path when no terminal segment exists. Mirrors
/// `commands::tags::derive_title`.
fn derive_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

/// File candidates for the `[[` link-autocomplete dropdown.
pub async fn link_autocomplete(
    state: &AppState,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let paths = files_for_link_query(open.vault.index(), &req.query, AUTOCOMPLETE_LIMIT).await?;
    let candidates = paths
        .into_iter()
        .map(|path| {
            let title = derive_title(&path);
            LinkCandidate { path, title }
        })
        .collect();
    Ok(LinkAutocompleteResponse { candidates })
}

/// Tag candidates for the `#` tag-autocomplete dropdown.
pub async fn tag_autocomplete(
    state: &AppState,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let candidates =
        tag_paths_for_prefix(open.vault.index(), &req.query, AUTOCOMPLETE_LIMIT).await?;
    Ok(TagAutocompleteResponse { candidates })
}

/// Block ids defined in the resolved target file. The target is resolved
/// the same way `resolve_link` does (exact vault path → unique basename
/// → unique suffix). Returns an empty list when the target doesn't
/// resolve. Capped server-side at `AUTOCOMPLETE_LIMIT`. See spec §9.11.
pub async fn block_id_autocomplete(
    state: &AppState,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, CubicalError> {
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

    let target_path = match resolve_target(&req.target_raw, &known) {
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
            OpenVault {
                vault: vault.clone(),
                cancel: CancellationToken::new(),
                scan_status: ScanStatusBackend::Complete,
                watcher: None,
            },
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

        let resp = block_id_autocomplete(
            &state,
            BlockIdAutocompleteRequest {
                vault_id: "v1".into(),
                target_raw: "Daily".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(
            resp.candidates,
            vec!["intro".to_string(), "summary".to_string()]
        );
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
