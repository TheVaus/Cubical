use cubical_core::vault::embeds::{extract_block, extract_section, strip_frontmatter};
use cubical_core::vault::links::{read_source_off_executor, resolve_target};
use cubical_core::vault::pending::materialize_on_read;
use cubical_index::blocks_for_file;

use crate::api::types::{EmbedKind, GetEmbedRequest, GetEmbedResponse, ResolvedAnchor};
use crate::commands::links::split_target_anchor;
use crate::commands::vault::mime_for_extension;
use crate::error::CubicalError;
use crate::state::AppState;

pub const MAX_EMBEDDED_FILE_BYTES: u64 = 25 * 1024 * 1024;

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
            mime: None,
        });
    };

    let mut type_rows = conn
        .query(
            "SELECT type_id FROM files WHERE path = ?1",
            libsql::params![target_path.clone()],
        )
        .await?;
    let target_type: Option<String> = match type_rows.next().await? {
        Some(row) => Some(row.get(0)?),
        None => None,
    };
    if target_type.as_deref() != Some("markdown") {
        let abs = vault.root().join(&target_path);
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(&abs))
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|b| b.len() as u64 <= MAX_EMBEDDED_FILE_BYTES);
        return Ok(GetEmbedResponse {
            kind: EmbedKind::File,
            mime: Some(mime_for_extension(&target_path).to_string()),
            content: bytes
                .map(|b| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &b)),
            target_path: Some(target_path),
        });
    }

    let abs = vault.root().join(&target_path);
    let Some(on_disk) = read_source_off_executor(&abs).await else {
        return Ok(GetEmbedResponse {
            kind: EmbedKind::Unresolved,
            target_path: Some(target_path),
            content: None,
            mime: None,
        });
    };

    let source = materialize_on_read(vault.index(), &target_path, &on_disk).await?;

    match anchor {
        None => Ok(GetEmbedResponse {
            kind: EmbedKind::Note,
            target_path: Some(target_path),
            content: Some(strip_frontmatter(&source).to_string()),
            mime: None,
        }),
        Some(ResolvedAnchor::Heading { value }) => match extract_section(&source, &value) {
            Some(content) => Ok(GetEmbedResponse {
                kind: EmbedKind::Section,
                target_path: Some(target_path),
                content: Some(content),
                mime: None,
            }),
            None => Ok(GetEmbedResponse {
                kind: EmbedKind::MissingAnchor,
                target_path: Some(target_path),
                content: None,
                mime: None,
            }),
        },
        Some(ResolvedAnchor::Block { value }) => {
            let blocks = blocks_for_file(vault.index(), &target_path).await?;
            match blocks.into_iter().find(|b| b.block_id == value) {
                Some(b) => Ok(GetEmbedResponse {
                    kind: EmbedKind::Block,
                    target_path: Some(target_path),
                    content: Some(extract_block(&source, b.position_hint)),
                    mime: None,
                }),
                None => Ok(GetEmbedResponse {
                    kind: EmbedKind::MissingAnchor,
                    target_path: Some(target_path),
                    content: None,
                    mime: None,
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
    async fn get_embed_serves_a_binary_target_as_base64_not_lossy_text() {
        let dir = tempdir().unwrap();
        let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE];
        std::fs::write(dir.path().join("pic.png"), png).unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "pic.png".into(),
            },
        )
        .await
        .expect("ok");

        assert!(matches!(resp.kind, EmbedKind::File));
        assert_eq!(resp.target_path.as_deref(), Some("pic.png"));
        assert_eq!(resp.mime.as_deref(), Some("image/png"));

        let content = resp.content.expect("bytes served");
        assert!(
            !content.contains('\u{FFFD}'),
            "payload must not carry lossy replacement characters"
        );
        let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &content)
            .expect("valid base64");
        assert_eq!(decoded, png, "bytes survive the embed round trip");
    }

    #[tokio::test]
    async fn get_embed_serves_a_csv_target_as_file_so_it_renders_like_its_tab() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("data.csv"), b"a,b\n1,2\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "data.csv".into(),
            },
        )
        .await
        .expect("ok");

        assert!(
            matches!(resp.kind, EmbedKind::File),
            "a csv must not arrive as Note, or it would be parsed as markdown"
        );
        assert_eq!(resp.mime.as_deref(), Some("text/csv"));
        let decoded = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            resp.content.expect("bytes"),
        )
        .expect("valid base64");
        assert_eq!(decoded, b"a,b\n1,2\n");
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
