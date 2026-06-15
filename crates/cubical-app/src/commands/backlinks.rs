//! Pure async command handler for `get_backlinks`.
//!
//! Reads `links` rows pointing at the target path, joins each row to
//! a short single-line snippet drawn from the source file's text, and
//! returns the result. The snippet helper is a pure function tested
//! in isolation; the handler itself is the only piece that touches
//! disk + libSQL.
//!
//! See `docs/layer-3-spec.md` §2.3 and §3.1.

use cubical_index::backlinks_for;

use crate::api::types::{Backlink, GetBacklinksRequest, GetBacklinksResponse};
use crate::commands::snippet::build_snippet;
use crate::error::CubicalError;
use crate::state::AppState;

/// List every backlink for `path` — every link row whose
/// `target_path` resolves to it — with a single-line context snippet
/// drawn from each source file.
///
/// Errors only when the vault is not open. A source file that has
/// gone missing on disk (e.g. deleted between extraction and the
/// query) yields an empty `context`; the row still appears so the
/// panel surfaces the stale link.
pub async fn get_backlinks(
    state: &AppState,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let rows = backlinks_for(open.vault.index(), &req.path).await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let abs = open.vault.root().join(&row.source_path);
        let context = match std::fs::read_to_string(&abs) {
            Ok(text) => build_snippet(&text, row.position),
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

    // -- End-to-end get_backlinks tests ---------------------------------

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

    /// Write a markdown file under the vault root *and* seed its
    /// `files` row. The handler reads the file from disk for the
    /// snippet, so both halves must exist.
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
        // Seed the index row but NOT the disk file — simulates a
        // file deleted between extraction and the panel query.
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
