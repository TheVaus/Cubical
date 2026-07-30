use std::sync::Arc;

use cubical_core::{atomic_write, sha256_bytes_hex, start_watcher, Vault, WatchEvent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::api::types::{
    CancelVaultScanRequest, CloseVaultRequest, CreateFileAtPathRequest, CreateFileAtPathResponse,
    CreateFileRequest, CreateFileResponse, CreateFolderRequest, CreateFolderResponse,
    DeletePathRequest, FileEntry, FrontmatterEntry, GetCanonicalAstRequest,
    GetCanonicalAstResponse, GetFrontmatterRequest, GetFrontmatterResponse, GetSettingRequest,
    GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse, ListFilesRequest,
    ListFilesResponse, OpenVaultRequest, OpenVaultResponse, ReadFileTextRequest,
    ReadFileTextResponse, ReloadSettingsRequest, ReloadSettingsResponse, ScanStatus,
    SetSettingRequest, SetSettingResponse, WriteFileTextRequest, WriteFileTextResponse,
};
use crate::error::CubicalError;
use crate::events::{spawn_scan_dispatcher, spawn_watcher_dispatcher, EventSink};
use crate::state::{AppState, OpenVault, ScanStatusBackend};

const WATCHER_CHANNEL_DEPTH: usize = 256;

impl From<ScanStatusBackend> for ScanStatus {
    fn from(value: ScanStatusBackend) -> Self {
        match value {
            ScanStatusBackend::InProgress => Self::InProgress,
            ScanStatusBackend::Complete => Self::Complete,
            ScanStatusBackend::Cancelled => Self::Cancelled,
        }
    }
}

fn find_open_vault_by_canonical_path(
    vaults: &std::collections::HashMap<String, OpenVault>,
    incoming: &std::path::Path,
) -> Option<(String, ScanStatusBackend)> {
    vaults.iter().find_map(|(id, ov)| {
        let root = std::fs::canonicalize(ov.vault.root()).ok()?;
        (root.as_path() == incoming).then(|| (id.clone(), ov.scan_status))
    })
}

pub async fn resolve_open_vault(
    state: &AppState,
    incoming_canonical: &std::path::Path,
) -> Option<(String, ScanStatus)> {
    let guard = state.vaults().read().await;
    find_open_vault_by_canonical_path(&guard, incoming_canonical)
        .map(|(id, status)| (id, status.into()))
}

pub async fn open_vault(
    state: &AppState,
    app: std::sync::Arc<dyn EventSink>,
    req: OpenVaultRequest,
    advertise_socket: Option<String>,
) -> Result<OpenVaultResponse, CubicalError> {
    let canonical = std::fs::canonicalize(&req.path).ok();
    if let Some(incoming) = &canonical {
        let guard = state.vaults().read().await;
        if let Some((existing_id, status)) = find_open_vault_by_canonical_path(&guard, incoming) {
            return Ok(OpenVaultResponse {
                vault_id: existing_id,
                scan_status: status.into(),
            });
        }
    }

    let lock_key = canonical.unwrap_or_else(|| req.path.clone());
    let lock_guard = match crate::vault_lock::acquire(&lock_key, advertise_socket.as_deref())
        .map_err(|e| CubicalError::Io(format!("acquiring vault lock: {e}")))?
    {
        crate::vault_lock::Acquire::Acquired(guard) => guard,
        crate::vault_lock::Acquire::Held(owner) => {
            return Err(CubicalError::VaultLocked {
                pid: owner.pid,
                socket_path: owner.socket_path,
            });
        }
    };

    let vault = Vault::open(&req.path).await?;
    let vault_id = state.new_vault_id();
    let cancel = CancellationToken::new();

    let (watch_tx, watch_rx) = mpsc::channel::<WatchEvent>(WATCHER_CHANNEL_DEPTH);
    let watcher = start_watcher(&vault, cancel.clone(), watch_tx)?;

    let settings = cubical_core::vault::settings::load(vault.root()).unwrap_or_else(|e| {
        tracing::warn!("settings load failed, using defaults: {e}");
        cubical_core::vault::settings::SettingsMap::new()
    });

    let mut open = OpenVault::new(
        vault.clone(),
        cancel.clone(),
        ScanStatusBackend::InProgress,
        Some(watcher),
        settings,
    );
    open.lock_guard = Some(lock_guard);
    let flush_own_writes = open.flush_own_writes.clone();
    let flush_in_progress = open.flush_in_progress.clone();
    let flush_timer_cancel = open.flush_timer_cancel.clone();
    let settings_handle = open.settings.clone();
    state.vaults().write().await.insert(vault_id.clone(), open);

    spawn_scan_dispatcher(
        app.clone(),
        state.vaults_arc(),
        vault_id.clone(),
        vault.clone(),
        cancel,
    );

    spawn_watcher_dispatcher(
        app.clone(),
        vault_id.clone(),
        vault.clone(),
        watch_rx,
        flush_own_writes.clone(),
        settings_handle,
    );

    crate::commands::rename::spawn_flush_timer(
        app.clone(),
        vault,
        flush_own_writes,
        flush_in_progress,
        vault_id.clone(),
        flush_timer_cancel,
    );

    Ok(OpenVaultResponse {
        vault_id,
        scan_status: ScanStatus::InProgress,
    })
}

pub async fn cancel_vault_scan(
    state: &AppState,
    req: CancelVaultScanRequest,
) -> Result<(), CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    open.cancel.cancel();
    Ok(())
}

pub async fn get_vault_info(
    state: &AppState,
    req: GetVaultInfoRequest,
) -> Result<GetVaultInfoResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let conn = open.vault.index().connection();

    let mut rows = conn
        .query("SELECT MAX(version) FROM schema_version", ())
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| CubicalError::Db("schema_version table empty".into()))?;
    let version: Option<i64> = row.get(0)?;
    let schema_version = u32::try_from(version.unwrap_or(0)).unwrap_or(u32::MAX);

    let mut rows = conn
        .query(
            "SELECT
                 COUNT(*),
                 SUM(CASE WHEN type_id = 'markdown' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN type_id = 'binary'   THEN 1 ELSE 0 END)
             FROM files",
            (),
        )
        .await?;
    let (file_count, markdown_count, binary_count) = match rows.next().await? {
        Some(row) => {
            let total: i64 = row.get(0)?;
            let md: Option<i64> = row.get(1)?;
            let bin: Option<i64> = row.get(2)?;
            (
                clamp_to_u32(total),
                clamp_to_u32(md.unwrap_or(0)),
                clamp_to_u32(bin.unwrap_or(0)),
            )
        }
        None => (0, 0, 0),
    };

    Ok(GetVaultInfoResponse {
        path: open.vault.root().to_path_buf(),
        file_count,
        markdown_count,
        binary_count,
        schema_version,
        scan_status: open.scan_status.into(),
    })
}

pub async fn list_files(
    state: &AppState,
    req: ListFilesRequest,
) -> Result<ListFilesResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    let limit: i64 = i64::from(req.limit.unwrap_or(u32::MAX));
    let offset: i64 = i64::from(req.offset.unwrap_or(0));

    let mut rows = conn
        .query(
            "SELECT path, type_id, size_bytes, mtime_unix
             FROM files
             ORDER BY path
             LIMIT ?1 OFFSET ?2",
            libsql::params![limit, offset],
        )
        .await?;
    let mut files: Vec<FileEntry> = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        let type_id: String = row.get(1)?;
        let size_bytes: i64 = row.get(2)?;
        let mtime_unix: i64 = row.get(3)?;
        files.push(FileEntry {
            path,
            type_id,
            size_bytes: u64::try_from(size_bytes).unwrap_or(0),
            mtime_unix,
        });
    }

    let total: i64 = {
        let mut rows = conn.query("SELECT COUNT(*) FROM files", ()).await?;
        match rows.next().await? {
            Some(row) => row.get(0)?,
            None => 0,
        }
    };

    let folders = cubical_index::list_folders(open.vault.index()).await?;

    Ok(ListFilesResponse {
        files,
        total: clamp_to_u32(total),
        folders,
    })
}

async fn clone_vault(state: &AppState, vault_id: &str) -> Result<Vault, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(vault_id.to_string()))?;
    Ok(open.vault.clone())
}

fn normalize_parent_dir(parent_dir: &str) -> Result<String, CubicalError> {
    let trimmed = parent_dir.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    for seg in trimmed.split('/') {
        if seg == ".." || seg == "." || seg.is_empty() {
            return Err(CubicalError::InvalidRequest(format!(
                "invalid parent_dir: {parent_dir}"
            )));
        }
    }
    Ok(trimmed.to_string())
}

fn first_free_path(
    parent_rel: &str,
    parent_abs: &std::path::Path,
    base: &str,
    ext: Option<&str>,
) -> Result<String, CubicalError> {
    for i in 0..10_000 {
        let stem = if i == 0 {
            base.to_string()
        } else {
            format!("{base} {i}")
        };
        let name = match ext {
            Some(e) => format!("{stem}.{e}"),
            None => stem,
        };
        if !parent_abs.join(&name).exists() {
            let rel = if parent_rel.is_empty() {
                name
            } else {
                format!("{parent_rel}/{name}")
            };
            return Ok(rel);
        }
    }
    Err(CubicalError::Io(format!(
        "could not find a free name for '{base}' in '{parent_rel}'"
    )))
}

fn normalize_rel_file_path(path: &str) -> Result<String, CubicalError> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Err(CubicalError::InvalidRequest("empty path".into()));
    }
    for seg in trimmed.split('/') {
        if seg == ".." || seg == "." || seg.is_empty() {
            return Err(CubicalError::InvalidRequest(format!(
                "invalid path: {path}"
            )));
        }
    }
    Ok(trimmed.to_string())
}

async fn create_empty_markdown(vault: &Vault, rel_path: &str) -> Result<String, CubicalError> {
    let abs_path = vault.root().join(rel_path);

    let abs_for_write = abs_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if let Some(parent) = abs_for_write.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        atomic_write(&abs_for_write, b"").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| CubicalError::Io(format!("create task join error: {e}")))?
    .map_err(CubicalError::Io)?;

    let now = unix_now_secs();
    let hash = sha256_bytes_hex(b"");
    vault
        .index()
        .connection()
        .execute(
            "INSERT INTO files (
                path, type_id, size_bytes, mtime_unix, content_hash,
                inode, last_seen, created_at, updated_at
            ) VALUES (?1, 'markdown', 0, ?2, ?3, NULL, ?2, ?2, ?2)
            ON CONFLICT(path) DO NOTHING",
            libsql::params![rel_path.to_string(), now, hash.clone()],
        )
        .await?;
    Ok(hash)
}

pub async fn create_file(
    state: &AppState,
    req: CreateFileRequest,
) -> Result<CreateFileResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let parent_rel = normalize_parent_dir(&req.parent_dir)?;
    let parent_abs = vault.root().join(&parent_rel);

    let rel_path = first_free_path(&parent_rel, &parent_abs, "Untitled", Some("md"))?;
    let content_hash = create_empty_markdown(&vault, &rel_path).await?;
    Ok(CreateFileResponse {
        path: rel_path,
        content_hash,
    })
}

pub async fn create_file_at_path(
    state: &AppState,
    req: CreateFileAtPathRequest,
) -> Result<CreateFileAtPathResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let rel_path = normalize_rel_file_path(&req.path)?;
    if vault.root().join(&rel_path).exists() {
        return Err(CubicalError::InvalidRequest(format!(
            "path already exists: {rel_path}"
        )));
    }
    let content_hash = create_empty_markdown(&vault, &rel_path).await?;
    Ok(CreateFileAtPathResponse {
        path: rel_path,
        content_hash,
    })
}

pub async fn create_folder(
    state: &AppState,
    req: CreateFolderRequest,
) -> Result<CreateFolderResponse, CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let parent_rel = normalize_parent_dir(&req.parent_dir)?;
    let parent_abs = vault.root().join(&parent_rel);

    let rel_path = first_free_path(&parent_rel, &parent_abs, "Untitled Folder", None)?;
    let abs_path = vault.root().join(&rel_path);

    tokio::task::spawn_blocking(move || std::fs::create_dir_all(&abs_path))
        .await
        .map_err(|e| CubicalError::Io(format!("create_folder task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    cubical_index::upsert_folder(vault.index(), &rel_path, unix_now_secs()).await?;

    Ok(CreateFolderResponse { path: rel_path })
}

pub async fn delete_path(state: &AppState, req: DeletePathRequest) -> Result<(), CubicalError> {
    let vault = clone_vault(state, &req.vault_id).await?;
    let rel_path = normalize_rel_file_path(&req.path)?;
    let abs_path = vault.root().join(&rel_path);
    if !abs_path.exists() {
        return Err(CubicalError::InvalidRequest(format!(
            "path does not exist: {rel_path}"
        )));
    }
    tokio::task::spawn_blocking(move || trash::delete(&abs_path))
        .await
        .map_err(|e| CubicalError::Io(format!("delete_path task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;
    Ok(())
}

pub async fn get_frontmatter(
    state: &AppState,
    req: GetFrontmatterRequest,
) -> Result<GetFrontmatterResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    let mut rows = conn
        .query(
            "SELECT 1 FROM files WHERE path = ?1",
            libsql::params![req.path.clone()],
        )
        .await?;
    if rows.next().await?.is_none() {
        return Err(CubicalError::FileNotFound(req.path));
    }

    let mut rows = conn
        .query(
            "SELECT key, value FROM frontmatter WHERE file_path = ?1 ORDER BY key",
            libsql::params![req.path],
        )
        .await?;
    let mut entries: Vec<FrontmatterEntry> = Vec::new();
    while let Some(row) = rows.next().await? {
        let key: String = row.get(0)?;
        let raw: String = row.get(1)?;
        let value = serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!(
                key = %key,
                error = %e,
                "frontmatter value not valid JSON; surfacing raw string",
            );
            serde_json::Value::String(raw.clone())
        });
        entries.push(FrontmatterEntry { key, value });
    }
    Ok(GetFrontmatterResponse { entries })
}

pub async fn read_file_text(
    state: &AppState,
    req: ReadFileTextRequest,
) -> Result<ReadFileTextResponse, CubicalError> {
    let (abs_path, vault) = {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        let conn = open.vault.index().connection();

        let mut rows = conn
            .query(
                "SELECT type_id FROM files WHERE path = ?1",
                libsql::params![req.path.clone()],
            )
            .await?;
        let row = rows
            .next()
            .await?
            .ok_or_else(|| CubicalError::FileNotFound(req.path.clone()))?;
        let type_id: String = row.get(0)?;
        if type_id != "markdown" {
            return Err(CubicalError::InvalidRequest(format!(
                "read_file_text only supports markdown files (path '{}' has type_id '{}')",
                req.path, type_id,
            )));
        }
        (open.vault.root().join(&req.path), open.vault.clone())
    };

    let on_disk = tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs_path))
        .await
        .map_err(|e| CubicalError::Io(format!("read task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    let content =
        cubical_core::vault::pending::materialize_on_read(vault.index(), &req.path, &on_disk)
            .await?;

    Ok(ReadFileTextResponse { content })
}

pub async fn write_file_text(
    state: &AppState,
    req: WriteFileTextRequest,
) -> Result<WriteFileTextResponse, CubicalError> {
    let (abs_path, current_hash) = {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        let conn = open.vault.index().connection();

        let mut rows = conn
            .query(
                "SELECT type_id, content_hash FROM files WHERE path = ?1",
                libsql::params![req.path.clone()],
            )
            .await?;
        let row = rows
            .next()
            .await?
            .ok_or_else(|| CubicalError::FileNotFound(req.path.clone()))?;
        let type_id: String = row.get(0)?;
        if type_id != "markdown" {
            return Err(CubicalError::InvalidRequest(format!(
                "write_file_text only supports markdown files (path '{}' has type_id '{}')",
                req.path, type_id,
            )));
        }
        let current_hash: String = row.get(1)?;
        (open.vault.root().join(&req.path), current_hash)
    };

    let new_hash = sha256_bytes_hex(req.content.as_bytes());
    let bytes_len = req.content.len();

    let abs_for_write = abs_path.clone();
    let content_for_write = req.content.into_bytes();
    tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, &content_for_write))
        .await
        .map_err(|e| CubicalError::Io(format!("write task join error: {e}")))??;

    let new_mtime = std::fs::metadata(&abs_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    let new_size = i64::try_from(bytes_len).unwrap_or(i64::MAX);

    let now = unix_now_secs();
    {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        let conn = open.vault.index().connection();

        if let Some(expected) = &req.expected_seen_hash {
            if expected != &current_hash {
                let detail = serde_json::json!({
                    "path": req.path,
                    "expected": expected,
                    "actual": current_hash,
                })
                .to_string();
                if let Err(e) = conn
                    .execute(
                        "INSERT INTO audit_log (timestamp, level, category, message, detail)
                         VALUES (?1, 'warn', 'external_edit_override', ?2, ?3)",
                        libsql::params![
                            now,
                            format!("override external edit on {}", req.path),
                            detail,
                        ],
                    )
                    .await
                {
                    tracing::warn!(error = %e, "write_file_text: external_edit_override audit insert failed");
                }
            }
        }

        if let Err(e) = conn
            .execute(
                "UPDATE files
                 SET size_bytes = ?1,
                     mtime_unix = ?2,
                     content_hash = ?3,
                     last_seen = ?4,
                     updated_at = ?4
                 WHERE path = ?5",
                libsql::params![new_size, new_mtime, new_hash.clone(), now, req.path.clone()],
            )
            .await
        {
            tracing::warn!(path = %req.path, error = %e, "write_file_text: files row update failed");
        }

        let detail = serde_json::json!({
            "path": req.path,
            "bytes": bytes_len,
            "new_content_hash": new_hash,
        })
        .to_string();
        if let Err(e) = conn
            .execute(
                "INSERT INTO audit_log (timestamp, level, category, message, detail)
                 VALUES (?1, 'info', 'autosave', ?2, ?3)",
                libsql::params![now, format!("autosave {}", req.path), detail],
            )
            .await
        {
            tracing::warn!(error = %e, "write_file_text: autosave audit insert failed");
        }
    }

    Ok(WriteFileTextResponse {
        new_content_hash: new_hash,
        new_mtime_unix: new_mtime,
    })
}

fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub async fn get_setting(
    state: &AppState,
    req: GetSettingRequest,
) -> Result<GetSettingResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    if !cubical_core::vault::settings::is_workspace_key(&req.key) {
        let map = open.settings.read().await;
        return Ok(GetSettingResponse {
            value: map.get(&req.key).cloned(),
        });
    }

    let conn = open.vault.index().connection();

    let mut rows = conn
        .query(
            "SELECT value FROM config WHERE key = ?1",
            libsql::params![req.key.clone()],
        )
        .await?;
    let value = match rows.next().await? {
        None => None,
        Some(row) => {
            let raw: String = row.get(0)?;
            let parsed = serde_json::from_str(&raw).map_err(|e| {
                CubicalError::InvalidRequest(format!(
                    "setting '{}' holds a corrupt (non-JSON) value: {e}",
                    req.key,
                ))
            })?;
            Some(parsed)
        }
    };
    Ok(GetSettingResponse { value })
}

pub async fn set_setting(
    state: &AppState,
    req: SetSettingRequest,
) -> Result<SetSettingResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    if !cubical_core::vault::settings::is_workspace_key(&req.key) {
        let settings = Arc::clone(&open.settings);
        let root = open.vault.root().to_path_buf();
        drop(guard);

        let snapshot = {
            let mut map = settings.write().await;
            map.insert(req.key.clone(), req.value.clone());
            map.clone()
        };

        tokio::task::spawn_blocking(move || cubical_core::vault::settings::save(&root, &snapshot))
            .await
            .map_err(|e| CubicalError::InvalidRequest(format!("settings save task panicked: {e}")))?
            .map_err(|e| CubicalError::InvalidRequest(format!("save settings: {e}")))?;

        return Ok(SetSettingResponse {});
    }

    let conn = open.vault.index().connection();

    let encoded = serde_json::to_string(&req.value)
        .map_err(|e| CubicalError::InvalidRequest(format!("setting value not encodable: {e}")))?;

    conn.execute(
        "INSERT INTO config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        libsql::params![req.key, encoded],
    )
    .await?;

    Ok(SetSettingResponse {})
}

pub async fn get_canonical_ast(
    state: &AppState,
    req: GetCanonicalAstRequest,
) -> Result<GetCanonicalAstResponse, CubicalError> {
    let ReadFileTextResponse { content } = read_file_text(
        state,
        ReadFileTextRequest {
            vault_id: req.vault_id,
            path: req.path,
        },
    )
    .await?;

    let document = tokio::task::spawn_blocking(move || cubical_ast::parse(&content))
        .await
        .map_err(|e| CubicalError::Io(format!("parse task join error: {e}")))?;

    Ok(GetCanonicalAstResponse { document })
}

pub async fn reload_settings(
    state: &AppState,
    req: ReloadSettingsRequest,
) -> Result<ReloadSettingsResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let fresh = cubical_core::vault::settings::load(open.vault.root())
        .map_err(|e| CubicalError::InvalidRequest(format!("reload settings: {e}")))?;
    *open.settings.write().await = fresh.clone();
    Ok(ReloadSettingsResponse { settings: fresh })
}

pub async fn close_vault(
    state: &AppState,
    app: &dyn EventSink,
    req: CloseVaultRequest,
) -> Result<(), CubicalError> {
    let removed = {
        let mut guard = state.vaults().write().await;
        guard.remove(&req.vault_id)
    };
    let Some(open) = removed else {
        return Err(CubicalError::VaultNotOpen(req.vault_id));
    };

    open.flush_timer_cancel.cancel();

    crate::commands::rename::flush_at_close(
        &open.vault,
        &open.flush_own_writes,
        &open.flush_in_progress,
        app,
        &req.vault_id,
    )
    .await;

    open.cancel.cancel();
    drop(open);
    Ok(())
}

fn clamp_to_u32(v: i64) -> u32 {
    if v < 0 {
        0
    } else {
        u32::try_from(v).unwrap_or(u32::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_core::Vault;
    use tempfile::tempdir;

    async fn fresh_state_with_vault(vault_id: &str) -> (tempfile::TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault.clone(),
                tokio_util::sync::CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, vault, state)
    }

    #[tokio::test]
    async fn reopen_same_path_returns_existing_vault() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        let incoming = std::fs::canonicalize(dir.path()).unwrap();
        let guard = state.vaults().read().await;
        let found = find_open_vault_by_canonical_path(&guard, &incoming);
        assert_eq!(found, Some(("v1".to_string(), ScanStatusBackend::Complete)));
    }

    #[tokio::test]
    async fn reopen_different_path_returns_none() {
        let (_dir_a, _vault_a, state) = fresh_state_with_vault("v1").await;
        let dir_b = tempdir().unwrap();
        let incoming = std::fs::canonicalize(dir_b.path()).unwrap();
        let guard = state.vaults().read().await;
        assert_eq!(find_open_vault_by_canonical_path(&guard, &incoming), None);
    }

    #[tokio::test]
    async fn create_file_makes_untitled_and_suffixes_on_collision() {
        let (dir, vault, state) = fresh_state_with_vault("v1").await;

        let r1 = create_file(
            &state,
            CreateFileRequest {
                vault_id: "v1".into(),
                parent_dir: String::new(),
            },
        )
        .await
        .expect("first create");
        assert_eq!(r1.path, "Untitled.md");
        assert_eq!(r1.content_hash, sha256_bytes_hex(b""));
        assert!(dir.path().join("Untitled.md").exists(), "file on disk");
        let mut rows = vault
            .index()
            .connection()
            .query(
                "SELECT type_id, content_hash FROM files WHERE path = 'Untitled.md'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("row");
        let ty: String = row.get(0).unwrap();
        assert_eq!(ty, "markdown");
        let stored_hash: String = row.get(1).unwrap();
        assert_eq!(stored_hash, r1.content_hash);

        let r2 = create_file(
            &state,
            CreateFileRequest {
                vault_id: "v1".into(),
                parent_dir: String::new(),
            },
        )
        .await
        .expect("second create");
        assert_eq!(r2.path, "Untitled 1.md");
    }

    #[tokio::test]
    async fn create_file_into_new_subdir_creates_parent() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        let r = create_file(
            &state,
            CreateFileRequest {
                vault_id: "v1".into(),
                parent_dir: "projects/2026".into(),
            },
        )
        .await
        .expect("create");
        assert_eq!(r.path, "projects/2026/Untitled.md");
        assert!(dir.path().join("projects/2026/Untitled.md").exists());
    }

    #[tokio::test]
    async fn create_file_rejects_parent_dir_escape() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = create_file(
            &state,
            CreateFileRequest {
                vault_id: "v1".into(),
                parent_dir: "../evil".into(),
            },
        )
        .await
        .expect_err("must reject ..");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn create_file_at_path_creates_note_at_exact_path() {
        let (dir, vault, state) = fresh_state_with_vault("v1").await;
        let r = create_file_at_path(
            &state,
            CreateFileAtPathRequest {
                vault_id: "v1".into(),
                path: "notes/Missing.md".into(),
            },
        )
        .await
        .expect("create at path");
        assert_eq!(r.path, "notes/Missing.md");
        assert_eq!(r.content_hash, sha256_bytes_hex(b""));
        assert!(dir.path().join("notes/Missing.md").exists());

        let mut rows = vault
            .index()
            .connection()
            .query(
                "SELECT type_id FROM files WHERE path = 'notes/Missing.md'",
                (),
            )
            .await
            .unwrap();
        let ty: String = rows.next().await.unwrap().expect("row").get(0).unwrap();
        assert_eq!(ty, "markdown");
    }

    #[tokio::test]
    async fn create_file_at_path_rejects_existing_path() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        std::fs::write(dir.path().join("Taken.md"), "body\n").unwrap();
        let err = create_file_at_path(
            &state,
            CreateFileAtPathRequest {
                vault_id: "v1".into(),
                path: "Taken.md".into(),
            },
        )
        .await
        .expect_err("must reject an existing path");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn create_file_at_path_rejects_escape() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = create_file_at_path(
            &state,
            CreateFileAtPathRequest {
                vault_id: "v1".into(),
                path: "../evil.md".into(),
            },
        )
        .await
        .expect_err("must reject ..");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn create_folder_makes_untitled_folder_and_tracks_it() {
        let (dir, vault, state) = fresh_state_with_vault("v1").await;
        let r = create_folder(
            &state,
            CreateFolderRequest {
                vault_id: "v1".into(),
                parent_dir: String::new(),
            },
        )
        .await
        .expect("create folder");
        assert_eq!(r.path, "Untitled Folder");
        assert!(dir.path().join("Untitled Folder").is_dir());
        let folders = cubical_index::list_folders(vault.index()).await.unwrap();
        assert_eq!(folders, vec!["Untitled Folder"]);

        let listing = list_files(
            &state,
            ListFilesRequest {
                vault_id: "v1".into(),
                limit: None,
                offset: None,
            },
        )
        .await
        .expect("list");
        assert_eq!(listing.folders, vec!["Untitled Folder"]);
    }

    #[tokio::test]
    async fn delete_path_removes_a_file() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        std::fs::write(dir.path().join("note.md"), "body\n").unwrap();

        delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect("delete");

        assert!(!dir.path().join("note.md").exists());
    }

    #[tokio::test]
    async fn delete_path_removes_a_folder_with_contents() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        std::fs::create_dir_all(dir.path().join("projects/nested")).unwrap();
        std::fs::write(dir.path().join("projects/a.md"), "a\n").unwrap();
        std::fs::write(dir.path().join("projects/nested/b.md"), "b\n").unwrap();

        delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "projects".into(),
            },
        )
        .await
        .expect("delete folder");

        assert!(!dir.path().join("projects").exists());
    }

    #[tokio::test]
    async fn delete_path_rejects_missing_path() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "ghost.md".into(),
            },
        )
        .await
        .expect_err("must reject a path that doesn't exist");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn delete_path_rejects_escape() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = delete_path(
            &state,
            DeletePathRequest {
                vault_id: "v1".into(),
                path: "../evil.md".into(),
            },
        )
        .await
        .expect_err("must reject ..");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    async fn seed_file_with_frontmatter(vault: &Vault, path: &str, entries: &[(&str, &str)]) {
        let conn = vault.index().connection();
        conn.execute(
            "INSERT INTO files (
                path, type_id, size_bytes, mtime_unix, content_hash,
                inode, last_seen, created_at, updated_at
            ) VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
            libsql::params![path],
        )
        .await
        .expect("seed files");
        for (k, v) in entries {
            conn.execute(
                "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, ?2, ?3)",
                libsql::params![path, *k, *v],
            )
            .await
            .expect("seed frontmatter");
        }
    }

    #[tokio::test]
    async fn get_frontmatter_returns_indexed_entries() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_with_frontmatter(
            &vault,
            "note.md",
            &[
                ("title", "\"Hello\""),
                ("count", "3"),
                ("tags", "[\"a\",\"b\"]"),
            ],
        )
        .await;

        let resp = get_frontmatter(
            &state,
            GetFrontmatterRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.entries.len(), 3);
        let map: std::collections::HashMap<String, serde_json::Value> =
            resp.entries.into_iter().map(|e| (e.key, e.value)).collect();
        assert_eq!(map["title"], serde_json::json!("Hello"));
        assert_eq!(map["count"], serde_json::json!(3));
        assert_eq!(map["tags"], serde_json::json!(["a", "b"]));
    }

    #[tokio::test]
    async fn get_frontmatter_returns_empty_for_known_file_without_keys() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_with_frontmatter(&vault, "plain.md", &[]).await;

        let resp = get_frontmatter(
            &state,
            GetFrontmatterRequest {
                vault_id: "v1".into(),
                path: "plain.md".into(),
            },
        )
        .await
        .expect("ok");

        assert!(resp.entries.is_empty());
    }

    #[tokio::test]
    async fn get_frontmatter_errors_for_unknown_path() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;

        let err = get_frontmatter(
            &state,
            GetFrontmatterRequest {
                vault_id: "v1".into(),
                path: "ghost.md".into(),
            },
        )
        .await
        .expect_err("should be FileNotFound");

        match err {
            CubicalError::FileNotFound(p) => assert_eq!(p, "ghost.md"),
            other => panic!("expected FileNotFound, got {other:?}"),
        }
    }

    async fn seed_file_on_disk(vault: &Vault, rel: &str, body: &str, type_id: &str) {
        let abs = vault.root().join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&abs, body).expect("write body");
        let conn = vault.index().connection();
        conn.execute(
            "INSERT INTO files (
                path, type_id, size_bytes, mtime_unix, content_hash,
                inode, last_seen, created_at, updated_at
            ) VALUES (?1, ?2, 0, 0, '', NULL, 0, 0, 0)",
            libsql::params![rel, type_id],
        )
        .await
        .expect("seed files");
    }

    #[tokio::test]
    async fn read_file_text_returns_content_for_markdown() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        let body = "# Hi\n\nA paragraph.\n";
        seed_file_on_disk(&vault, "note.md", body, "markdown").await;

        let resp = read_file_text(
            &state,
            ReadFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.content, body);
    }

    #[tokio::test]
    async fn read_file_text_materializes_pending_rewrites() {
        use cubical_index::{enqueue_pending, NewPendingRewrite, RewriteKind};

        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        let body = "see [[Daily]] for context\n";
        seed_file_on_disk(&vault, "note.md", body, "markdown").await;

        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "note.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "Daily".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let resp = read_file_text(
            &state,
            ReadFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.content, "see [[Journal]] for context\n");
        let on_disk = std::fs::read_to_string(vault.root().join("note.md")).unwrap();
        assert_eq!(on_disk, body);
    }

    #[tokio::test]
    async fn read_file_text_rejects_binary() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "icon.png", "fake png bytes", "binary").await;

        let err = read_file_text(
            &state,
            ReadFileTextRequest {
                vault_id: "v1".into(),
                path: "icon.png".into(),
            },
        )
        .await
        .expect_err("should be InvalidRequest");
        match err {
            CubicalError::InvalidRequest(msg) => assert!(msg.contains("markdown")),
            other => panic!("expected InvalidRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_file_text_errors_for_unknown_path() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = read_file_text(
            &state,
            ReadFileTextRequest {
                vault_id: "v1".into(),
                path: "missing.md".into(),
            },
        )
        .await
        .expect_err("should be FileNotFound");
        assert!(matches!(err, CubicalError::FileNotFound(p) if p == "missing.md"));
    }

    #[tokio::test]
    async fn get_canonical_ast_returns_parsed_document() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        let body = "# Hello\n\nA paragraph.\n";
        seed_file_on_disk(&vault, "note.md", body, "markdown").await;

        let resp = get_canonical_ast(
            &state,
            GetCanonicalAstRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect("ok");

        assert_eq!(resp.document.source_len, body.len());
        assert_eq!(resp.document.blocks.len(), 2);
        assert!(matches!(
            &resp.document.blocks[0],
            cubical_ast::Block::Heading { level: 1, .. }
        ));
        assert!(matches!(
            &resp.document.blocks[1],
            cubical_ast::Block::Paragraph { .. }
        ));
    }

    #[tokio::test]
    async fn get_canonical_ast_errors_for_unknown_path() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = get_canonical_ast(
            &state,
            GetCanonicalAstRequest {
                vault_id: "v1".into(),
                path: "ghost.md".into(),
            },
        )
        .await
        .expect_err("should be FileNotFound");
        assert!(matches!(err, CubicalError::FileNotFound(p) if p == "ghost.md"));
    }

    #[tokio::test]
    async fn get_canonical_ast_errors_for_unknown_vault() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = get_canonical_ast(
            &state,
            GetCanonicalAstRequest {
                vault_id: "v999".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "v999"));
    }

    #[tokio::test]
    async fn get_canonical_ast_rejects_binary() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "icon.png", "bytes", "binary").await;

        let err = get_canonical_ast(
            &state,
            GetCanonicalAstRequest {
                vault_id: "v1".into(),
                path: "icon.png".into(),
            },
        )
        .await
        .expect_err("should be InvalidRequest");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    async fn last_audit_row(vault: &Vault) -> Option<(String, String, String, String)> {
        let conn = vault.index().connection();
        let mut rows = conn
            .query(
                "SELECT level, category, message, detail
                 FROM audit_log ORDER BY id DESC LIMIT 1",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap()?;
        Some((
            row.get(0).unwrap(),
            row.get(1).unwrap(),
            row.get(2).unwrap(),
            row.get(3).unwrap(),
        ))
    }

    #[tokio::test]
    async fn write_file_text_writes_content_and_returns_matching_hash() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "note.md", "original\n", "markdown").await;

        let new = "rewritten body\n";
        let resp = write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
                content: new.into(),
                expected_seen_hash: None,
            },
        )
        .await
        .expect("ok");

        let on_disk = std::fs::read_to_string(vault.root().join("note.md")).unwrap();
        assert_eq!(on_disk, new);

        assert_eq!(
            resp.new_content_hash,
            cubical_core::sha256_bytes_hex(new.as_bytes())
        );

        let conn = vault.index().connection();
        let mut rows = conn
            .query(
                "SELECT content_hash, size_bytes FROM files WHERE path = 'note.md'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("row");
        let stored_hash: String = row.get(0).unwrap();
        let stored_size: i64 = row.get(1).unwrap();
        assert_eq!(stored_hash, resp.new_content_hash);
        assert_eq!(stored_size, new.len() as i64);
    }

    #[tokio::test]
    async fn write_file_text_writes_autosave_audit_row() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "note.md", "x\n", "markdown").await;

        write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
                content: "y\n".into(),
                expected_seen_hash: None,
            },
        )
        .await
        .expect("ok");

        let (level, category, message, detail) = last_audit_row(&vault).await.expect("audit row");
        assert_eq!(level, "info");
        assert_eq!(category, "autosave");
        assert!(message.contains("note.md"), "{message}");
        let parsed: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(parsed["path"], "note.md");
        assert_eq!(parsed["bytes"], 2);
        assert!(parsed["new_content_hash"].is_string());
    }

    #[tokio::test]
    async fn write_file_text_writes_external_edit_override_audit_on_hash_mismatch() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "note.md", "current\n", "markdown").await;
        vault
            .index()
            .connection()
            .execute(
                "UPDATE files SET content_hash = 'CURRENT_HASH' WHERE path = 'note.md'",
                (),
            )
            .await
            .unwrap();

        write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
                content: "user buffer\n".into(),
                expected_seen_hash: Some("STALE_HASH".into()),
            },
        )
        .await
        .expect("ok");

        let conn = vault.index().connection();

        let mut rows = conn
            .query(
                "SELECT level, detail FROM audit_log WHERE category = 'autosave'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("autosave row");
        let level: String = row.get(0).unwrap();
        assert_eq!(level, "info");

        let mut rows = conn
            .query(
                "SELECT level, detail FROM audit_log
                 WHERE category = 'external_edit_override'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("override row");
        let level: String = row.get(0).unwrap();
        let detail: String = row.get(1).unwrap();
        assert_eq!(level, "warn");
        let parsed: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(parsed["expected"], "STALE_HASH");
        assert_eq!(parsed["actual"], "CURRENT_HASH");
    }

    #[tokio::test]
    async fn write_file_text_no_override_audit_when_hashes_match() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "note.md", "x\n", "markdown").await;
        vault
            .index()
            .connection()
            .execute(
                "UPDATE files SET content_hash = 'KNOWN_HASH' WHERE path = 'note.md'",
                (),
            )
            .await
            .unwrap();

        write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
                content: "y\n".into(),
                expected_seen_hash: Some("KNOWN_HASH".into()),
            },
        )
        .await
        .expect("ok");

        let conn = vault.index().connection();
        let mut rows = conn
            .query(
                "SELECT category FROM audit_log
                 WHERE category = 'external_edit_override'",
                (),
            )
            .await
            .unwrap();
        assert!(rows.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn write_file_text_rejects_binary() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "icon.png", "fake bytes", "binary").await;

        let err = write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "icon.png".into(),
                content: "uh oh".into(),
                expected_seen_hash: None,
            },
        )
        .await
        .expect_err("should be InvalidRequest");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn write_file_text_errors_for_unknown_path() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;

        let err = write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "ghost.md".into(),
                content: "nope".into(),
                expected_seen_hash: None,
            },
        )
        .await
        .expect_err("should be FileNotFound");
        assert!(matches!(err, CubicalError::FileNotFound(p) if p == "ghost.md"));
    }

    #[tokio::test]
    async fn write_file_text_errors_for_unknown_vault() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v999".into(),
                path: "note.md".into(),
                content: "x".into(),
                expected_seen_hash: None,
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "v999"));
    }

    #[tokio::test]
    async fn write_file_text_round_trips_with_subsequent_read() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file_on_disk(&vault, "note.md", "v0\n", "markdown").await;

        write_file_text(
            &state,
            WriteFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
                content: "v1 body\n".into(),
                expected_seen_hash: None,
            },
        )
        .await
        .unwrap();

        let resp = read_file_text(
            &state,
            ReadFileTextRequest {
                vault_id: "v1".into(),
                path: "note.md".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(resp.content, "v1 body\n");
    }

    #[tokio::test]
    async fn get_frontmatter_errors_for_unknown_vault() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;

        let err = get_frontmatter(
            &state,
            GetFrontmatterRequest {
                vault_id: "v999".into(),
                path: "note.md".into(),
            },
        )
        .await
        .expect_err("should be VaultNotOpen");

        match err {
            CubicalError::VaultNotOpen(v) => assert_eq!(v, "v999"),
            other => panic!("expected VaultNotOpen, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn set_then_get_setting_round_trips_boolean() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "editor.raw_source_default".into(),
                value: serde_json::json!(true),
            },
        )
        .await
        .expect("set ok");

        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "editor.raw_source_default".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, Some(serde_json::json!(true)));
    }

    #[tokio::test]
    async fn set_then_get_setting_round_trips_string() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
                value: serde_json::json!("dark"),
            },
        )
        .await
        .expect("set ok");

        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, Some(serde_json::json!("dark")));
    }

    #[tokio::test]
    async fn set_then_get_setting_round_trips_number() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "editor.autosave_debounce_ms".into(),
                value: serde_json::json!(300),
            },
        )
        .await
        .expect("set ok");

        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "editor.autosave_debounce_ms".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, Some(serde_json::json!(300)));
    }

    #[tokio::test]
    async fn set_then_get_setting_round_trips_null() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "some.key".into(),
                value: serde_json::Value::Null,
            },
        )
        .await
        .expect("set ok");

        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "some.key".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, Some(serde_json::Value::Null));
    }

    #[tokio::test]
    async fn get_setting_returns_none_for_absent_key() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "never.written".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, None);
    }

    #[tokio::test]
    async fn get_setting_returns_invalid_request_for_corrupt_json() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO config (key, value) VALUES ('ui.bad_key', 'not json{')",
                (),
            )
            .await
            .unwrap();

        let err = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "ui.bad_key".into(),
            },
        )
        .await
        .expect_err("should be InvalidRequest");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn set_setting_upsert_overwrites_existing_key() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
                value: serde_json::json!("light"),
            },
        )
        .await
        .expect("first set");
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
                value: serde_json::json!("dark"),
            },
        )
        .await
        .expect("second set");

        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, Some(serde_json::json!("dark")));
    }

    #[tokio::test]
    async fn get_setting_errors_for_unknown_vault() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v999".into(),
                key: "k".into(),
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "v999"));
    }

    #[tokio::test]
    async fn set_setting_errors_for_unknown_vault() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v999".into(),
                key: "k".into(),
                value: serde_json::json!(1),
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "v999"));
    }

    #[tokio::test]
    async fn set_setting_persists_across_vault_reopen() {
        let dir = tempdir().unwrap();

        {
            let vault = Vault::open(dir.path()).await.expect("first open");
            let state = AppState::new();
            state.vaults().write().await.insert(
                "v1".into(),
                OpenVault::new(
                    vault,
                    tokio_util::sync::CancellationToken::new(),
                    ScanStatusBackend::Complete,
                    None,
                    cubical_core::vault::settings::SettingsMap::new(),
                ),
            );
            set_setting(
                &state,
                SetSettingRequest {
                    vault_id: "v1".into(),
                    key: "appearance.theme_mode".into(),
                    value: serde_json::json!("dark"),
                },
            )
            .await
            .expect("set ok");
        }

        let vault = Vault::open(dir.path()).await.expect("reopen");
        let loaded_settings = cubical_core::vault::settings::load(vault.root()).unwrap_or_default();
        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".into(),
            OpenVault::new(
                vault,
                tokio_util::sync::CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                loaded_settings,
            ),
        );

        let resp = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
            },
        )
        .await
        .expect("get ok");
        assert_eq!(resp.value, Some(serde_json::json!("dark")));
    }

    #[tokio::test]
    async fn settings_key_reads_from_the_file_backed_map() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "plugins.dataview_enabled".into(),
                value: serde_json::json!(false),
            },
        )
        .await
        .unwrap();
        let got = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "plugins.dataview_enabled".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(got.value, Some(serde_json::json!(false)));
    }

    #[tokio::test]
    async fn first_settings_write_creates_the_file_and_workspace_stays_in_db() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        let cfg = cubical_core::vault::settings::settings_path(dir.path());
        assert!(!cfg.exists(), "no file before any settings change (lazy)");

        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "editor.raw_source_default".into(),
                value: serde_json::json!(true),
            },
        )
        .await
        .unwrap();
        assert!(cfg.exists(), "settings write creates config.toml");

        set_setting(
            &state,
            SetSettingRequest {
                vault_id: "v1".into(),
                key: "ui.right_sidebar_collapsed".into(),
                value: serde_json::json!(true),
            },
        )
        .await
        .unwrap();
        let on_disk = std::fs::read_to_string(&cfg).unwrap();
        assert!(
            !on_disk.contains("right_sidebar"),
            "workspace state stays in the DB"
        );
    }

    #[tokio::test]
    async fn reload_settings_picks_up_an_external_file_edit() {
        let (dir, _vault, state) = fresh_state_with_vault("v1").await;
        let root = dir.path().to_path_buf();

        let mut m = cubical_core::vault::settings::SettingsMap::new();
        m.insert("appearance.theme_mode".into(), serde_json::json!("light"));
        cubical_core::vault::settings::save(&root, &m).unwrap();

        let resp = reload_settings(
            &state,
            ReloadSettingsRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            resp.settings.get("appearance.theme_mode"),
            Some(&serde_json::json!("light"))
        );
        let got = get_setting(
            &state,
            GetSettingRequest {
                vault_id: "v1".into(),
                key: "appearance.theme_mode".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(got.value, Some(serde_json::json!("light")));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn open_vault_declines_a_second_process_and_releases_on_close() {
        let _env = crate::vault_lock::RUNTIME_ENV_GUARD.lock().unwrap();
        let runtime = tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", runtime.path());

        let vault_dir = tempdir().unwrap();
        let path = vault_dir.path().to_path_buf();
        let sink: Arc<dyn EventSink> = Arc::new(crate::events::NoopEventSink);

        let state_a = AppState::new();
        let opened = open_vault(
            &state_a,
            Arc::clone(&sink),
            OpenVaultRequest { path: path.clone() },
            None,
        )
        .await
        .expect("first frontend owns the vault");

        let state_b = AppState::new();
        let err = open_vault(
            &state_b,
            Arc::clone(&sink),
            OpenVaultRequest { path: path.clone() },
            None,
        )
        .await
        .expect_err("a second frontend must be declined while the vault is owned");
        assert!(matches!(err, CubicalError::VaultLocked { .. }));

        close_vault(
            &state_a,
            sink.as_ref(),
            CloseVaultRequest {
                vault_id: opened.vault_id,
            },
        )
        .await
        .expect("close releases the lock");

        let canonical = std::fs::canonicalize(&path).unwrap();
        match crate::vault_lock::acquire(&canonical, None).unwrap() {
            crate::vault_lock::Acquire::Acquired(_) => {}
            crate::vault_lock::Acquire::Held(_) => {
                panic!("ownership lock must be free once the owner has closed the vault")
            }
        }

        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn resolve_open_vault_finds_the_open_vault_and_its_scan_status() {
        let _guard = crate::vault_lock::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt"));
        let state = AppState::new();
        let opened = open_vault(
            &state,
            std::sync::Arc::new(crate::events::NoopEventSink),
            OpenVaultRequest {
                path: dir.path().to_path_buf(),
            },
            None,
        )
        .await
        .unwrap();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let found = resolve_open_vault(&state, &canonical).await;
        assert_eq!(
            found.as_ref().map(|(id, _)| id.as_str()),
            Some(opened.vault_id.as_str())
        );
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }

    #[tokio::test]
    async fn resolve_open_vault_reports_a_still_scanning_vault() {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            "scanning".to_string(),
            OpenVault::new(
                vault,
                tokio_util::sync::CancellationToken::new(),
                ScanStatusBackend::InProgress,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let found = resolve_open_vault(&state, &canonical).await;
        assert!(matches!(
            found.as_ref().map(|(id, s)| (id.as_str(), s)),
            Some(("scanning", ScanStatus::InProgress))
        ));
    }
}
