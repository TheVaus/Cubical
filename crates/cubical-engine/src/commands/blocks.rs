use std::fmt::Write as _;

use cubical_core::vault::blocks::refresh_blocks;
use cubical_index::broken_block_refs;
use sha2::{Digest, Sha256};

use crate::api::types::{
    BrokenBlockRefDto, CreateBlockRefRequest, CreateBlockRefResponse, GetBrokenBlockRefsRequest,
    GetBrokenBlockRefsResponse,
};
use crate::commands::open::open_vault_cloned;
use crate::error::CubicalError;
use crate::state::AppState;

pub async fn create_block_ref(
    state: &AppState,
    req: CreateBlockRefRequest,
) -> Result<CreateBlockRefResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;

    let (target_path, abs) = crate::commands::paths::vault_file(&vault, &req.target_path)?;
    let source = tokio::fs::read_to_string(&abs)
        .await
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    let (new_source, block_id) = mint_block_id(&source, req.position, &target_path);
    if new_source != source {
        tokio::fs::write(&abs, &new_source)
            .await
            .map_err(|e| CubicalError::Io(e.to_string()))?;
    }
    refresh_blocks(&vault, &target_path, &new_source)
        .await
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    Ok(CreateBlockRefResponse { block_id })
}

fn mint_block_id(source: &str, position: u64, path: &str) -> (String, String) {
    let pos = (position as usize).min(source.len());
    let line_start = source[..pos].rfind('\n').map_or(0, |i| i + 1);
    let line_end = source[pos..].find('\n').map_or(source.len(), |i| pos + i);
    let line = &source[line_start..line_end];
    let line_trimmed = line.trim_end();

    if let Some(existing) = trailing_block_id(line_trimmed) {
        return (source.to_string(), existing);
    }

    let existing_ids = existing_block_ids(source);
    let id = unique_id(path, position, &existing_ids);

    let insert_at = line_start + line_trimmed.len();
    let mut new_source = String::with_capacity(source.len() + id.len() + 2);
    new_source.push_str(&source[..insert_at]);
    new_source.push_str(&format!(" ^{id}"));
    new_source.push_str(&source[insert_at..]);
    (new_source, id)
}

fn trailing_block_id(line: &str) -> Option<String> {
    let caret = line.rfind('^')?;
    let id = &line[caret + 1..];
    let before_ok = caret == 0
        || line[..caret]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
    if before_ok && is_valid_id(id) {
        Some(id.to_string())
    } else {
        None
    }
}

fn existing_block_ids(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|l| trailing_block_id(l.trim_end()))
        .collect()
}

fn is_valid_id(id: &str) -> bool {
    let mut c = id.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_')
        && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn unique_id(path: &str, position: u64, existing: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(b":");
    hasher.update(position.to_le_bytes());
    let hex = hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        });
    let base = format!("b{}", &hex[..6]);
    if !existing.contains(&base) {
        return base;
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("the loop always returns")
}

pub async fn get_broken_block_refs(
    state: &AppState,
    req: GetBrokenBlockRefsRequest,
) -> Result<GetBrokenBlockRefsResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let broken = broken_block_refs(vault.index()).await?;
    let refs = broken
        .into_iter()
        .map(|b| BrokenBlockRefDto {
            source_file_path: b.source_file_path,
            target_file_path: b.target_file_path,
            target_block_id: b.target_block_id,
        })
        .collect();
    Ok(GetBrokenBlockRefsResponse { refs })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
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

    #[tokio::test]
    async fn create_block_ref_mints_and_persists_id() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "first para\n\nsecond para\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .unwrap();

        let resp = create_block_ref(
            &state,
            CreateBlockRefRequest {
                vault_id: "v1".into(),
                target_path: "a.md".into(),
                position: 0,
            },
        )
        .await
        .expect("ok");
        let id = resp.block_id;
        assert!(!id.is_empty());

        let src = std::fs::read_to_string(dir.path().join("a.md")).unwrap();
        assert!(
            src.lines().next().unwrap().ends_with(&format!("^{id}")),
            "src was: {src:?}"
        );

        let exists = cubical_index::block_exists(vault.index(), "a.md", &id)
            .await
            .unwrap();
        assert!(exists);
    }

    #[tokio::test]
    async fn create_block_ref_is_idempotent_when_line_already_has_id() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "first para ^existing\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .unwrap();
        let resp = create_block_ref(
            &state,
            CreateBlockRefRequest {
                vault_id: "v1".into(),
                target_path: "a.md".into(),
                position: 0,
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.block_id, "existing");
        let src = std::fs::read_to_string(dir.path().join("a.md")).unwrap();
        assert_eq!(src, "first para ^existing\n");
    }

    #[tokio::test]
    async fn get_broken_block_refs_reports_missing_targets() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("src.md"), "ref [[tgt#^gone]]\n").unwrap();
        std::fs::write(dir.path().join("tgt.md"), "body\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .unwrap();

        let resp = get_broken_block_refs(
            &state,
            GetBrokenBlockRefsRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.refs.len(), 1);
        assert_eq!(resp.refs[0].target_block_id, "gone");
    }

    #[test]
    fn generated_ids_are_stable_across_hasher_upgrades() {
        assert_eq!(unique_id("notes/a.md", 42, &[]), "bd064a2");
    }
}
