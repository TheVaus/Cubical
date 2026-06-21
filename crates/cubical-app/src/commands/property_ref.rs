//! Property-reference resolver (cross-file). Resolves `[[note.prop]]` to
//! the target note's top-level frontmatter scalar, rendered to a display
//! string. Self-refs (`[[.prop]]`) are resolved on the frontend and never
//! reach this command. See
//! `docs/superpowers/specs/2026-06-20-property-reference-interpolation-design.md`.

use cubical_ast::parse;
use cubical_core::vault::links::{read_source_off_executor, resolve_target};
use cubical_core::vault::pending::materialize_on_read;

use crate::api::types::{GetPropertyRequest, GetPropertyResponse, PropertyRefKind};
use crate::error::CubicalError;
use crate::state::AppState;

/// Resolve a cross-file property reference to a display string.
pub async fn get_property(
    state: &AppState,
    req: GetPropertyRequest,
) -> Result<GetPropertyResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let vault = open.vault.clone();
    drop(guard);

    // Snapshot files.path for resolution (mirror commands/embeds).
    let conn = vault.index().connection();
    let mut rows = conn
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut known: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        known.push(row.get(0)?);
    }

    let Some(target_path) = resolve_target(&req.note_raw, &known) else {
        return Ok(GetPropertyResponse {
            kind: PropertyRefKind::NoteUnresolved,
            value: None,
        });
    };

    let abs = vault.root().join(&target_path);
    let Some(on_disk) = read_source_off_executor(&abs).await else {
        // Unreadable file folds into NoteUnresolved (watcher heals on the
        // next change — same policy as get_embed).
        return Ok(GetPropertyResponse {
            kind: PropertyRefKind::NoteUnresolved,
            value: None,
        });
    };
    let source = materialize_on_read(vault.index(), &target_path, &on_disk).await?;

    let Some(fm) = parse(&source).frontmatter else {
        return Ok(GetPropertyResponse {
            kind: PropertyRefKind::PropertyMissing,
            value: None,
        });
    };
    match fm.entries.iter().find(|(k, _)| k == &req.property) {
        Some((_, v)) => match scalar_to_display(v) {
            Some(value) => Ok(GetPropertyResponse {
                kind: PropertyRefKind::Resolved,
                value: Some(value),
            }),
            None => Ok(GetPropertyResponse {
                kind: PropertyRefKind::PropertyMissing,
                value: None,
            }),
        },
        None => Ok(GetPropertyResponse {
            kind: PropertyRefKind::PropertyMissing,
            value: None,
        }),
    }
}

/// Render a frontmatter scalar to display text. Strings pass through;
/// numbers/bools stringify; arrays of scalars join with ", "; objects and
/// null are "not a scalar" (PropertyMissing). v1 — no typing/formatting.
fn scalar_to_display(v: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(scalar_to_display).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(", "))
            }
        }
        Value::Object(_) | Value::Null => None,
    }
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

    async fn scan(vault: &Vault) {
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
    }

    #[tokio::test]
    async fn get_property_returns_scalar_value() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Gandalf.md"), "---\nage: 2019\n---\nbody\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;
        let resp = get_property(
            &state,
            GetPropertyRequest {
                vault_id: "v1".into(),
                note_raw: "Gandalf".into(),
                property: "age".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, PropertyRefKind::Resolved));
        assert_eq!(resp.value.as_deref(), Some("2019"));
    }

    #[tokio::test]
    async fn get_property_string_and_list_render() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("Hero.md"),
            "---\nname: Ann\naliases:\n  - A\n  - B\n---\n",
        )
        .unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;
        let name = get_property(
            &state,
            GetPropertyRequest {
                vault_id: "v1".into(),
                note_raw: "Hero".into(),
                property: "name".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(name.value.as_deref(), Some("Ann"));
        let aliases = get_property(
            &state,
            GetPropertyRequest {
                vault_id: "v1".into(),
                note_raw: "Hero".into(),
                property: "aliases".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(aliases.value.as_deref(), Some("A, B"));
    }

    #[tokio::test]
    async fn get_property_missing_key() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Gandalf.md"), "---\nage: 2019\n---\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;
        let resp = get_property(
            &state,
            GetPropertyRequest {
                vault_id: "v1".into(),
                note_raw: "Gandalf".into(),
                property: "ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, PropertyRefKind::PropertyMissing));
        assert!(resp.value.is_none());
    }

    #[tokio::test]
    async fn get_property_unresolved_note() {
        let dir = tempdir().unwrap();
        let (_v, state) = state_with_vault_at(dir.path(), "v1").await;
        let resp = get_property(
            &state,
            GetPropertyRequest {
                vault_id: "v1".into(),
                note_raw: "Nobody".into(),
                property: "age".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, PropertyRefKind::NoteUnresolved));
    }
}
