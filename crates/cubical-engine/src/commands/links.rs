//! Pure async command handler for the L3 wiki-link surface.
//!
//! `resolve_link` answers "which file does this wiki-link target point
//! at?" by combining the AST-level link grammar (target + optional
//! anchor, parsed inline here from a simple substring split) with
//! `cubical_core::vault::links::resolve_target` over the live `files`
//! table. No I/O beyond a single libSQL query — resolution itself is
//! pure.
//!
//! See `docs/layer-3-spec.md` §4 (resolution order) and §8 Session A.

use cubical_core::vault::links::resolve_target;

use crate::api::types::{ResolveLinkRequest, ResolveLinkResponse, ResolvedAnchor};
use crate::error::CubicalError;
use crate::state::AppState;

/// Resolve a wiki-link's target string to a vault-relative path,
/// returning the parsed anchor alongside it.
///
/// Returns `target_path: None` when no unique match exists; the anchor
/// (if any) is still echoed so the frontend can choose to surface a
/// "broken link" indicator with the right kind hint.
pub async fn resolve_link(
    state: &AppState,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    // Snapshot the current files.path set. The resolver is pure over
    // this snapshot — ordering doesn't matter for resolution, but
    // we sort so determinism is preserved if two paths tie.
    let mut rows = conn
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut known: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        let s: String = row.get(0)?;
        known.push(s);
    }

    let (target, anchor) = split_target_anchor(&req.target_raw);
    let target_path = resolve_target(&target, &known);

    Ok(ResolveLinkResponse {
        target_path,
        anchor,
    })
}

/// Split a wiki-link `target_raw` (post-tokenizer shape, no `[[…]]`,
/// no leading `!`) into its target portion and optional anchor.
///
/// Mirrors `cubical_ast::wikilink::scan_wikilinks`'s grammar for the
/// `target#anchor` body — anchor always precedes the `|display` pipe,
/// so the caller is responsible for having stripped any `|display`
/// segment before passing the string in. (The frontend only sends the
/// target portion; this matches the AST's `WikiLink::target` field.)
pub(crate) fn split_target_anchor(target_raw: &str) -> (String, Option<ResolvedAnchor>) {
    let trimmed = target_raw.trim();
    let (target, anchor_text) = match trimmed.find('#') {
        Some(hash) => (&trimmed[..hash], Some(&trimmed[hash + 1..])),
        None => (trimmed, None),
    };
    let anchor = anchor_text.and_then(|rest| {
        if let Some(block) = rest.strip_prefix('^') {
            let v = block.trim();
            if v.is_empty() {
                None
            } else {
                Some(ResolvedAnchor::Block {
                    value: v.to_string(),
                })
            }
        } else {
            let v = rest.trim();
            if v.is_empty() {
                None
            } else {
                Some(ResolvedAnchor::Heading {
                    value: v.to_string(),
                })
            }
        }
    });
    (target.trim().to_string(), anchor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_target_with_heading_anchor() {
        let (t, a) = split_target_anchor("note#heading");
        assert_eq!(t, "note");
        assert!(matches!(
            a,
            Some(ResolvedAnchor::Heading { ref value }) if value == "heading"
        ));
    }

    #[test]
    fn splits_target_with_block_anchor() {
        let (t, a) = split_target_anchor("note#^intro");
        assert_eq!(t, "note");
        assert!(matches!(
            a,
            Some(ResolvedAnchor::Block { ref value }) if value == "intro"
        ));
    }

    #[test]
    fn no_anchor_returns_none() {
        let (t, a) = split_target_anchor("note");
        assert_eq!(t, "note");
        assert!(a.is_none());
    }

    #[test]
    fn whitespace_only_anchor_is_dropped() {
        let (t, a) = split_target_anchor("note#   ");
        assert_eq!(t, "note");
        assert!(a.is_none());
    }

    // -- End-to-end resolve_link tests ----------------------------------

    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    /// Build an `AppState` with one open vault registered under
    /// `vault_id`. Returns the temp dir (keeps the vault root alive),
    /// the `Vault` handle, and the wired `AppState`.
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

    /// Seed a `files` row so `resolve_link` has something to match.
    async fn seed_files_row(vault: &Vault, rel: &str) {
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

    #[tokio::test]
    async fn resolve_link_returns_path_for_known_file() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_files_row(&vault, "b.md").await;

        let resp = resolve_link(
            &state,
            ResolveLinkRequest {
                vault_id: "v1".into(),
                target_raw: "b".into(),
                source_path: None,
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.target_path.as_deref(), Some("b.md"));
        assert!(resp.anchor.is_none());
    }

    #[tokio::test]
    async fn resolve_link_returns_none_for_unknown() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;

        let resp = resolve_link(
            &state,
            ResolveLinkRequest {
                vault_id: "v1".into(),
                target_raw: "nope".into(),
                source_path: None,
            },
        )
        .await
        .expect("ok");

        assert!(resp.target_path.is_none());
    }

    #[tokio::test]
    async fn resolve_link_strips_and_returns_heading_anchor() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_files_row(&vault, "b.md").await;

        let resp = resolve_link(
            &state,
            ResolveLinkRequest {
                vault_id: "v1".into(),
                target_raw: "b#heading".into(),
                source_path: None,
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.target_path.as_deref(), Some("b.md"));
        assert!(matches!(
            resp.anchor,
            Some(ResolvedAnchor::Heading { ref value }) if value == "heading"
        ));
    }

    #[tokio::test]
    async fn resolve_link_strips_and_returns_block_anchor() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_files_row(&vault, "b.md").await;

        let resp = resolve_link(
            &state,
            ResolveLinkRequest {
                vault_id: "v1".into(),
                target_raw: "b#^intro".into(),
                source_path: None,
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.target_path.as_deref(), Some("b.md"));
        assert!(matches!(
            resp.anchor,
            Some(ResolvedAnchor::Block { ref value }) if value == "intro"
        ));
    }

    #[tokio::test]
    async fn resolve_link_unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;

        let err = resolve_link(
            &state,
            ResolveLinkRequest {
                vault_id: "ghost".into(),
                target_raw: "anything".into(),
                source_path: None,
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }

    #[tokio::test]
    async fn resolve_link_anchor_without_target_match_still_returns_anchor() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;

        let resp = resolve_link(
            &state,
            ResolveLinkRequest {
                vault_id: "v1".into(),
                target_raw: "ghost#heading".into(),
                source_path: None,
            },
        )
        .await
        .expect("ok");

        assert!(resp.target_path.is_none());
        assert!(matches!(resp.anchor, Some(ResolvedAnchor::Heading { .. })));
    }
}
