use cubical_engine::api::types::{
    CreateFileAtPathRequest, CreateFileRequest, CreateFolderRequest, DeletePathRequest,
    GetBacklinksRequest, GetSettingRequest, ListFilesRequest, RenameFileRequest,
    RenameFolderRequest, ResolveLinkRequest, SetSettingRequest, UndoRenameRequest,
    WriteFileTextRequest,
};
use cubical_engine::commands::{backlinks, links, rename, vault};
use cubical_engine::error::CubicalError;
use cubical_engine::events::{self, EventSink, VaultSettingChanged};
use cubical_engine::state::AppState;

use crate::protocol::{Command, Outcome};

pub async fn dispatch(
    vault_id: &str,
    command: Command,
    state: &AppState,
    sink: &dyn EventSink,
) -> Result<Outcome, CubicalError> {
    let vid = vault_id.to_string();
    match command {
        Command::List => {
            let resp = vault::list_files(
                state,
                ListFilesRequest {
                    vault_id: vid,
                    limit: None,
                    offset: None,
                },
            )
            .await?;
            let files = resp
                .files
                .into_iter()
                .filter(|f| f.type_id == "markdown")
                .map(|f| f.path)
                .collect();
            Ok(Outcome::Files(files))
        }
        Command::Resolve { target } => {
            let resp = links::resolve_link(
                state,
                ResolveLinkRequest {
                    vault_id: vid,
                    target_raw: target.clone(),
                    source_path: None,
                },
            )
            .await?;
            Ok(Outcome::Resolved {
                target,
                path: resp.target_path,
            })
        }
        Command::Backlinks { path } => {
            let resp = backlinks::get_backlinks(
                state,
                GetBacklinksRequest {
                    vault_id: vid,
                    path,
                },
            )
            .await?;
            Ok(Outcome::Backlinks(
                resp.backlinks.into_iter().map(|b| b.source_path).collect(),
            ))
        }
        Command::NewNote { at, parent } => {
            let path = match at {
                Some(path) => {
                    vault::create_file_at_path(
                        state,
                        CreateFileAtPathRequest {
                            vault_id: vid,
                            path,
                        },
                    )
                    .await?
                    .path
                }
                None => {
                    vault::create_file(
                        state,
                        CreateFileRequest {
                            vault_id: vid,
                            parent_dir: parent.unwrap_or_default(),
                        },
                    )
                    .await?
                    .path
                }
            };
            Ok(Outcome::Created(path))
        }
        Command::NewFolder { parent } => {
            let resp = vault::create_folder(
                state,
                CreateFolderRequest {
                    vault_id: vid,
                    parent_dir: parent.unwrap_or_default(),
                },
            )
            .await?;
            Ok(Outcome::Created(resp.path))
        }
        Command::Write { path, content } => {
            vault::write_file_text(
                state,
                WriteFileTextRequest {
                    vault_id: vid,
                    path: path.clone(),
                    content,
                    expected_seen_hash: None,
                },
            )
            .await?;
            Ok(Outcome::Wrote(path))
        }
        Command::RenameFile { from, to } => {
            let resp = rename::rename_file(
                state,
                sink,
                RenameFileRequest {
                    vault_id: vid,
                    from_path: from,
                    to_path: to.clone(),
                },
            )
            .await?;
            Ok(Outcome::Renamed {
                to,
                pending_count: resp.pending_count,
            })
        }
        Command::RenameFolder { from, to } => {
            let resp = rename::rename_folder(
                state,
                sink,
                RenameFolderRequest {
                    vault_id: vid,
                    from_path: from,
                    to_path: to.clone(),
                },
            )
            .await?;
            Ok(Outcome::Renamed {
                to,
                pending_count: resp.pending_count,
            })
        }
        Command::Rm { path } => {
            vault::delete_path(
                state,
                DeletePathRequest {
                    vault_id: vid,
                    path: path.clone(),
                },
            )
            .await?;
            Ok(Outcome::Trashed(path))
        }
        Command::Set { key, value } => {
            vault::set_setting(
                state,
                SetSettingRequest {
                    vault_id: vid,
                    key: key.clone(),
                    value: value.clone(),
                },
            )
            .await?;
            events::emit_setting_changed(
                sink,
                VaultSettingChanged {
                    vault_id: vault_id.to_string(),
                    key: key.clone(),
                    value,
                },
            );
            Ok(Outcome::SettingSet(key))
        }
        Command::Get { key } => {
            let resp = vault::get_setting(
                state,
                GetSettingRequest {
                    vault_id: vid,
                    key: key.clone(),
                },
            )
            .await?;
            Ok(Outcome::SettingGet {
                key,
                value: resp.value,
            })
        }
        Command::UndoRename { op_id } => {
            let resp = rename::undo_rename(
                state,
                sink,
                UndoRenameRequest {
                    vault_id: vid,
                    rename_op_id: op_id,
                },
            )
            .await?;
            Ok(Outcome::UndoRename {
                op_id,
                removed: resp.removed,
                pending_count: resp.pending_count,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_engine::api::types::{GetVaultInfoRequest, OpenVaultRequest, ScanStatus};
    use cubical_engine::commands::vault;
    use cubical_engine::events::{AppEvent, NoopEventSink};
    use cubical_engine::state::AppState;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<AppEvent>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: AppEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    async fn open_temp(dir: &std::path::Path) -> (AppState, String) {
        let state = AppState::new();
        let opened = vault::open_vault(
            &state,
            Arc::new(NoopEventSink),
            OpenVaultRequest {
                path: dir.to_path_buf(),
            },
            None,
        )
        .await
        .unwrap();
        loop {
            let info = vault::get_vault_info(
                &state,
                GetVaultInfoRequest {
                    vault_id: opened.vault_id.clone(),
                },
            )
            .await
            .unwrap();
            if matches!(info.scan_status, ScanStatus::Complete) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        (state, opened.vault_id)
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_new_note_creates_a_file() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt"));
        let (state, vault_id) = open_temp(dir.path()).await;

        let outcome = dispatch(
            &vault_id,
            Command::NewNote {
                at: Some("Daily.md".into()),
                parent: None,
            },
            &state,
            &NoopEventSink,
        )
        .await
        .unwrap();

        match outcome {
            Outcome::Created(path) => assert_eq!(path, "Daily.md"),
            other => panic!("expected Created, got {other:?}"),
        }
        assert!(dir.path().join("Daily.md").exists());
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_write_replaces_body() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt2"));
        std::fs::write(dir.path().join("N.md"), "old").unwrap();
        let (state, vault_id) = open_temp(dir.path()).await;

        let outcome = dispatch(
            &vault_id,
            Command::Write {
                path: "N.md".into(),
                content: "new body".into(),
            },
            &state,
            &NoopEventSink,
        )
        .await
        .unwrap();

        assert_eq!(outcome, Outcome::Wrote("N.md".into()));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("N.md")).unwrap(),
            "new body"
        );
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_set_emits_setting_changed_so_the_ui_can_refresh() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt3"));
        let (state, vault_id) = open_temp(dir.path()).await;
        let sink = RecordingSink::default();

        dispatch(
            &vault_id,
            Command::Set {
                key: "editor.minimap_enabled".into(),
                value: serde_json::json!(true),
            },
            &state,
            &sink,
        )
        .await
        .unwrap();

        let events = sink.events.lock().unwrap();
        let changed: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AppEvent::SettingChanged(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(
            changed.len(),
            1,
            "set must emit exactly one setting-changed"
        );
        assert_eq!(changed[0].vault_id, vault_id);
        assert_eq!(changed[0].key, "editor.minimap_enabled");
        assert_eq!(changed[0].value, serde_json::json!(true));

        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_set_emits_nothing_when_the_key_is_rejected() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt4"));
        let (state, _vault_id) = open_temp(dir.path()).await;
        let sink = RecordingSink::default();

        let err = dispatch(
            "no-such-vault",
            Command::Set {
                key: "editor.minimap_enabled".into(),
                value: serde_json::json!(true),
            },
            &state,
            &sink,
        )
        .await;

        assert!(err.is_err(), "unknown vault must fail");
        assert!(
            sink.events.lock().unwrap().is_empty(),
            "a failed set must not claim the setting changed",
        );

        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }
}
