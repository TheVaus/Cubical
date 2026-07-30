use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use cubical_engine::api::types::{GetSettingRequest, GetVaultInfoRequest, SetSettingRequest};
use cubical_engine::commands::vault;
use cubical_engine::error::CubicalError;
use cubical_engine::state::AppState;

use super::content::{pointer_line, render, POINTER_FILES};

pub const OFFERED_SETTING_KEY: &str = "terminal.agent_instructions_offered";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentInstructionsStatus {
    pub offered: bool,
    pub canonical_path: String,
    pub existing_pointers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentInstructionsAccepted {
    pub created: Vec<String>,
    pub skipped: Vec<String>,
}

pub fn canonical_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".cubical").join("agent-instructions.md")
}

pub fn sync_canonical(vault_root: &Path) -> std::io::Result<bool> {
    let path = canonical_path(vault_root);
    let wanted = render();
    if matches!(std::fs::read_to_string(&path), Ok(cur) if cur == wanted) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, wanted)?;
    Ok(true)
}

pub fn existing_pointers(vault_root: &Path) -> Vec<String> {
    POINTER_FILES
        .iter()
        .filter(|name| vault_root.join(name).exists())
        .map(|name| name.to_string())
        .collect()
}

pub fn write_pointers(vault_root: &Path) -> std::io::Result<AgentInstructionsAccepted> {
    let line = pointer_line();
    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for name in POINTER_FILES {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(vault_root.join(name))
        {
            Ok(mut file) => {
                file.write_all(line.as_bytes())?;
                created.push(name.to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                skipped.push(name.to_string());
            }
            Err(e) => return Err(e),
        }
    }
    Ok(AgentInstructionsAccepted { created, skipped })
}

pub async fn status(
    state: &AppState,
    vault_id: &str,
) -> Result<AgentInstructionsStatus, CubicalError> {
    let root = vault_root(state, vault_id).await?;
    Ok(AgentInstructionsStatus {
        offered: is_offered(state, vault_id).await?,
        canonical_path: canonical_path(&root).to_string_lossy().into_owned(),
        existing_pointers: existing_pointers(&root),
    })
}

pub async fn accept(
    state: &AppState,
    vault_id: &str,
) -> Result<AgentInstructionsAccepted, CubicalError> {
    let root = vault_root(state, vault_id).await?;
    sync_canonical(&root)
        .map_err(|e| CubicalError::Io(format!("write agent instructions: {e}")))?;
    let outcome =
        write_pointers(&root).map_err(|e| CubicalError::Io(format!("write pointer file: {e}")))?;
    mark_offered(state, vault_id).await?;
    Ok(outcome)
}

pub async fn decline(state: &AppState, vault_id: &str) -> Result<(), CubicalError> {
    mark_offered(state, vault_id).await
}

async fn vault_root(state: &AppState, vault_id: &str) -> Result<PathBuf, CubicalError> {
    let info = vault::get_vault_info(
        state,
        GetVaultInfoRequest {
            vault_id: vault_id.to_string(),
        },
    )
    .await?;
    Ok(info.path)
}

async fn is_offered(state: &AppState, vault_id: &str) -> Result<bool, CubicalError> {
    let resp = vault::get_setting(
        state,
        GetSettingRequest {
            vault_id: vault_id.to_string(),
            key: OFFERED_SETTING_KEY.to_string(),
        },
    )
    .await?;
    Ok(resp.value == Some(serde_json::Value::Bool(true)))
}

async fn mark_offered(state: &AppState, vault_id: &str) -> Result<(), CubicalError> {
    vault::set_setting(
        state,
        SetSettingRequest {
            vault_id: vault_id.to_string(),
            key: OFFERED_SETTING_KEY.to_string(),
            value: serde_json::Value::Bool(true),
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use cubical_core::Vault;
    use cubical_engine::state::{OpenVault, ScanStatusBackend};
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn open(files: &[(&str, &str)]) -> (TempDir, AppState) {
        let (dir, _vault, state) = open_vault(files).await;
        (dir, state)
    }

    async fn open_vault(files: &[(&str, &str)]) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        for (rel, body) in files {
            std::fs::write(dir.path().join(rel), body).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open vault");
        let settings = cubical_core::vault::settings::load(dir.path()).unwrap();
        let state = state_for(vault.clone(), settings).await;
        (dir, vault, state)
    }

    async fn state_for(
        vault: Vault,
        settings: cubical_core::vault::settings::SettingsMap,
    ) -> AppState {
        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".to_string(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                settings,
            ),
        );
        state
    }

    fn root_entries(dir: &TempDir) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn sync_writes_the_canonical_file_with_the_real_verb_list() {
        let (dir, _state) = open(&[]).await;
        assert!(sync_canonical(dir.path()).unwrap());
        let text = std::fs::read_to_string(canonical_path(dir.path())).unwrap();
        for verb in [
            "cubical list",
            "cubical resolve <TARGET>",
            "cubical backlinks <PATH>",
            "cubical new note",
            "cubical new folder",
            "cubical write <PATH>",
            "cubical rename <FROM> <TO>",
            "cubical rm <PATH>",
            "cubical set <KEY> <VALUE>",
            "cubical get <KEY>",
            "cubical undo-rename <OP_ID>",
        ] {
            assert!(text.contains(verb), "missing {verb}");
        }
    }

    #[tokio::test]
    async fn sync_is_a_no_op_when_the_file_is_already_current() {
        let (dir, _state) = open(&[]).await;
        assert!(sync_canonical(dir.path()).unwrap());
        assert!(!sync_canonical(dir.path()).unwrap());
    }

    #[tokio::test]
    async fn sync_rewrites_a_stale_file() {
        let (dir, _state) = open(&[]).await;
        std::fs::create_dir_all(dir.path().join(".cubical")).unwrap();
        std::fs::write(canonical_path(dir.path()), "stale").unwrap();
        assert!(sync_canonical(dir.path()).unwrap());
        assert_ne!(
            std::fs::read_to_string(canonical_path(dir.path())).unwrap(),
            "stale"
        );
    }

    #[tokio::test]
    async fn sync_writes_nothing_to_the_vault_root() {
        let (dir, _state) = open(&[("Note.md", "# n\n")]).await;
        sync_canonical(dir.path()).unwrap();
        assert_eq!(root_entries(&dir), vec![".cubical", "Note.md"]);
    }

    #[tokio::test]
    async fn status_starts_unoffered() {
        let (_dir, state) = open(&[]).await;
        let s = status(&state, "v1").await.unwrap();
        assert!(!s.offered);
        assert!(s.existing_pointers.is_empty());
        assert!(s.canonical_path.ends_with("agent-instructions.md"));
    }

    #[tokio::test]
    async fn declining_writes_nothing_to_the_vault_root_and_records_the_offer() {
        let (dir, state) = open(&[("Note.md", "# n\n")]).await;
        let before = root_entries(&dir);
        decline(&state, "v1").await.unwrap();
        assert_eq!(root_entries(&dir), before);
        assert!(status(&state, "v1").await.unwrap().offered);
    }

    #[tokio::test]
    async fn accepting_creates_both_pointers_exactly_once() {
        let (dir, state) = open(&[]).await;
        let first = accept(&state, "v1").await.unwrap();
        assert_eq!(first.created, vec!["AGENTS.md", "CLAUDE.md"]);
        assert!(first.skipped.is_empty());

        let agents = dir.path().join("AGENTS.md");
        let claude = dir.path().join("CLAUDE.md");
        let body = std::fs::read_to_string(&agents).unwrap();
        assert_eq!(body, std::fs::read_to_string(&claude).unwrap());
        assert_eq!(body.lines().count(), 1);
        assert!(body.contains(".cubical/agent-instructions.md"));

        let second = accept(&state, "v1").await.unwrap();
        assert!(second.created.is_empty());
        assert_eq!(second.skipped, vec!["AGENTS.md", "CLAUDE.md"]);
        assert_eq!(std::fs::read_to_string(&agents).unwrap(), body);
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), body);
    }

    #[tokio::test]
    async fn accepting_never_overwrites_a_user_authored_claude_md() {
        let mine = "# my own instructions\n\nnothing to do with Cubical\n";
        let (dir, state) = open(&[("CLAUDE.md", mine)]).await;

        let outcome = accept(&state, "v1").await.unwrap();
        assert_eq!(outcome.created, vec!["AGENTS.md"]);
        assert_eq!(outcome.skipped, vec!["CLAUDE.md"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            mine
        );
    }

    #[tokio::test]
    async fn accepting_never_overwrites_a_user_authored_agents_md() {
        let mine = "my agents file\n";
        let (dir, state) = open(&[("AGENTS.md", mine), ("CLAUDE.md", mine)]).await;

        let outcome = accept(&state, "v1").await.unwrap();
        assert!(outcome.created.is_empty());
        assert_eq!(outcome.skipped, vec!["AGENTS.md", "CLAUDE.md"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(),
            mine
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            mine
        );
    }

    #[tokio::test]
    async fn existing_pointers_are_reported_before_any_offer() {
        let (_dir, state) = open(&[("CLAUDE.md", "mine\n")]).await;
        let s = status(&state, "v1").await.unwrap();
        assert_eq!(s.existing_pointers, vec!["CLAUDE.md"]);
        assert!(!s.offered);
    }

    #[tokio::test]
    async fn accepting_records_the_offer() {
        let (_dir, state) = open(&[]).await;
        accept(&state, "v1").await.unwrap();
        assert!(status(&state, "v1").await.unwrap().offered);
    }

    #[tokio::test]
    async fn the_offered_flag_persists_to_the_vault_config_file() {
        let (dir, state) = open(&[]).await;
        decline(&state, "v1").await.unwrap();

        let on_disk = cubical_core::vault::settings::load(dir.path()).unwrap();
        assert_eq!(
            on_disk.get(OFFERED_SETTING_KEY),
            Some(&serde_json::Value::Bool(true))
        );

        let (_reopened, fresh) = reopen(dir).await;
        assert!(status(&fresh, "v1").await.unwrap().offered);
    }

    async fn reopen(dir: TempDir) -> (TempDir, AppState) {
        let vault = Vault::open(dir.path()).await.expect("reopen vault");
        let settings = cubical_core::vault::settings::load(dir.path()).unwrap();
        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".to_string(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                settings,
            ),
        );
        (dir, state)
    }

    #[tokio::test]
    async fn unknown_vault_is_an_error_not_a_write() {
        let (dir, state) = open(&[]).await;
        assert!(status(&state, "nope").await.is_err());
        assert!(accept(&state, "nope").await.is_err());
        assert!(decline(&state, "nope").await.is_err());
        assert!(!dir.path().join("AGENTS.md").exists());
        assert!(!dir.path().join("CLAUDE.md").exists());
    }
}
