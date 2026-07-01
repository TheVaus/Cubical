//! Pure async command handler for `query_tag_page`.
//!
//! Returns every file carrying `tag_path` or any of its descendants
//! (prefix match — `tag:parent` matches `parent`, `parent/child`,
//! deeper). Matching is case-insensitive; display titles are derived
//! from the basename.
//!
//! See `docs/layer-3-spec.md` §2.5 and §3.1.

use std::path::Path;

use cubical_index::files_for_tag_prefix;

use crate::api::types::{QueryTagPageRequest, QueryTagPageResponse, TagPageFile};
use crate::error::CubicalError;
use crate::state::AppState;

/// Derive a display title from a vault-relative path: the filename
/// without its `.md` extension. Falls back to the full path string when
/// the path has no terminal segment (e.g. the empty string).
fn derive_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

/// List every file carrying `tag_path` or any descendant tag, with
/// display titles derived from each file's basename. Sorted by `path`.
///
/// Empty response when no file matches — the UI shows an empty-state
/// panel rather than erroring.
pub async fn query_tag_page(
    state: &AppState,
    req: QueryTagPageRequest,
) -> Result<QueryTagPageResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let paths = files_for_tag_prefix(open.vault.index(), &req.tag_path).await?;

    let files = paths
        .into_iter()
        .map(|path| {
            let title = derive_title(&path);
            TagPageFile { path, title }
        })
        .collect();

    Ok(QueryTagPageResponse { files })
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

    async fn seed_file(vault: &Vault, rel: &str) {
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

    fn tag(path: &str, source: TagSource) -> TagRow {
        TagRow {
            tag_path: path.into(),
            source,
        }
    }

    #[test]
    fn derive_title_drops_extension() {
        assert_eq!(derive_title("notes/Hello World.md"), "Hello World");
        assert_eq!(derive_title("README.md"), "README");
    }

    #[test]
    fn derive_title_handles_no_extension() {
        assert_eq!(derive_title("plain"), "plain");
    }

    #[test]
    fn derive_title_handles_dot_prefix() {
        // A leading-dot file like `.cubical` has no stem.extension split
        // so the stem is the whole basename. Acceptable for our needs.
        assert_eq!(derive_title("dir/.cubical"), ".cubical");
    }

    #[tokio::test]
    async fn empty_vault_yields_empty_response() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let resp = query_tag_page(
            &state,
            QueryTagPageRequest {
                vault_id: "v1".into(),
                tag_path: "todo".into(),
            },
        )
        .await
        .expect("ok");
        assert!(resp.files.is_empty());
    }

    #[tokio::test]
    async fn returns_exact_match_and_descendants() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "parent.md").await;
        seed_file(&vault, "child.md").await;
        seed_file(&vault, "grand.md").await;
        seed_file(&vault, "sibling.md").await;
        replace_tags_for_file(
            vault.index(),
            "parent.md",
            &[tag("project", TagSource::Inline)],
        )
        .await
        .expect("parent");
        replace_tags_for_file(
            vault.index(),
            "child.md",
            &[tag("project/cubical", TagSource::Frontmatter)],
        )
        .await
        .expect("child");
        replace_tags_for_file(
            vault.index(),
            "grand.md",
            &[tag("project/cubical/l3", TagSource::Inline)],
        )
        .await
        .expect("grand");
        replace_tags_for_file(
            vault.index(),
            "sibling.md",
            &[tag("projection", TagSource::Inline)],
        )
        .await
        .expect("sibling");

        let resp = query_tag_page(
            &state,
            QueryTagPageRequest {
                vault_id: "v1".into(),
                tag_path: "project".into(),
            },
        )
        .await
        .expect("ok");
        let paths: Vec<&str> = resp.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["child.md", "grand.md", "parent.md"]);
        // Titles derived from basenames.
        assert_eq!(resp.files[0].title, "child");
        assert_eq!(resp.files[1].title, "grand");
        assert_eq!(resp.files[2].title, "parent");
    }

    #[tokio::test]
    async fn case_insensitive_match() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "a.md").await;
        replace_tags_for_file(vault.index(), "a.md", &[tag("ToDo", TagSource::Inline)])
            .await
            .expect("a");
        let resp = query_tag_page(
            &state,
            QueryTagPageRequest {
                vault_id: "v1".into(),
                tag_path: "todo".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.files.len(), 1);
        assert_eq!(resp.files[0].path, "a.md");
    }

    #[tokio::test]
    async fn dedupes_when_same_file_carries_tag_via_inline_and_frontmatter() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "a.md").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[
                tag("todo", TagSource::Inline),
                tag("todo", TagSource::Frontmatter),
            ],
        )
        .await
        .expect("a");
        let resp = query_tag_page(
            &state,
            QueryTagPageRequest {
                vault_id: "v1".into(),
                tag_path: "todo".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.files.len(), 1);
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = query_tag_page(
            &state,
            QueryTagPageRequest {
                vault_id: "ghost".into(),
                tag_path: "todo".into(),
            },
        )
        .await
        .expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
