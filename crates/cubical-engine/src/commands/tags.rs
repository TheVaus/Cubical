use std::path::Path;

use cubical_index::{all_tag_assignments, files_for_tag_prefix};

use crate::api::types::{
    ListTagAssignmentsRequest, ListTagAssignmentsResponse, QueryTagPageRequest,
    QueryTagPageResponse, TagAssignmentDto, TagPageFile,
};
use crate::commands::open::open_vault_cloned;
use crate::error::CubicalError;
use crate::state::AppState;

fn derive_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

pub async fn query_tag_page(
    state: &AppState,
    req: QueryTagPageRequest,
) -> Result<QueryTagPageResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let paths = files_for_tag_prefix(vault.index(), &req.tag_path).await?;

    let files = paths
        .into_iter()
        .map(|path| {
            let title = derive_title(&path);
            TagPageFile { path, title }
        })
        .collect();

    Ok(QueryTagPageResponse { files })
}

pub async fn list_tag_assignments(
    state: &AppState,
    req: ListTagAssignmentsRequest,
) -> Result<ListTagAssignmentsResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let assignments = all_tag_assignments(vault.index())
        .await?
        .into_iter()
        .map(|a| TagAssignmentDto {
            tag_path: a.tag_path,
            file_path: a.file_path,
        })
        .collect();

    Ok(ListTagAssignmentsResponse { assignments })
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

    #[tokio::test]
    async fn list_tag_assignments_returns_every_tag_file_pair() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "a.md").await;
        seed_file(&vault, "b.md").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[
                tag("project/alpha", TagSource::Inline),
                tag("todo", TagSource::Frontmatter),
            ],
        )
        .await
        .expect("tags a");
        replace_tags_for_file(vault.index(), "b.md", &[tag("todo", TagSource::Inline)])
            .await
            .expect("tags b");

        let resp = list_tag_assignments(
            &state,
            ListTagAssignmentsRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");

        let pairs: Vec<(String, String)> = resp
            .assignments
            .into_iter()
            .map(|a| (a.tag_path, a.file_path))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("project/alpha".to_string(), "a.md".to_string()),
                ("todo".to_string(), "a.md".to_string()),
                ("todo".to_string(), "b.md".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn list_tag_assignments_empty_vault_yields_empty_response() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let resp = list_tag_assignments(
            &state,
            ListTagAssignmentsRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");
        assert!(resp.assignments.is_empty());
    }

    #[tokio::test]
    async fn list_tag_assignments_unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = list_tag_assignments(
            &state,
            ListTagAssignmentsRequest {
                vault_id: "ghost".into(),
            },
        )
        .await
        .expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
