//! Pure async command handlers for the vault surface.
//!
//! No `tauri` import lives in this module. The Tauri-aware glue (event
//! emission, the `AppHandle` type) is reached through `crate::events`,
//! which is the single migration touchpoint for backend → frontend
//! transport. Handlers are unit-testable by constructing an [`AppState`]
//! and calling them directly; the dispatcher branch is exercised by the
//! `cargo tauri dev` smoke pass and by the events module's logic.
//!
//! See `docs/layer-0-spec.md` §8.

use std::sync::Arc;

use cubical_core::{atomic_write, sha256_bytes_hex, start_watcher, Vault, WatchEvent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::api::types::{
    CancelVaultScanRequest, CloseVaultRequest, FileEntry, FrontmatterEntry, GetCanonicalAstRequest,
    GetCanonicalAstResponse, GetFrontmatterRequest, GetFrontmatterResponse, GetSettingRequest,
    GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse, ListFilesRequest,
    ListFilesResponse, OpenVaultRequest, OpenVaultResponse, ReadFileTextRequest,
    ReadFileTextResponse, ReloadSettingsRequest, ReloadSettingsResponse, ScanStatus,
    SetSettingRequest, SetSettingResponse, WriteFileTextRequest, WriteFileTextResponse,
};
use crate::error::CubicalError;
use crate::events::{spawn_scan_dispatcher, spawn_watcher_dispatcher, AppHandle};
use crate::state::{AppState, OpenVault, ScanStatusBackend};

/// Bound on the watcher's mpsc buffer. A burst (e.g. `git checkout`
/// touching dozens of files at once) clears in well under this depth;
/// going much higher would just hide a sluggish dispatcher.
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

/// Find an already-open vault whose canonical root matches `incoming`
/// (a path the caller has already canonicalized), for an idempotent
/// re-open. `Vault` stores its root un-canonicalized, so each stored
/// root is canonicalized here for comparison; a stored root that no
/// longer canonicalizes (e.g. its directory was removed) simply does
/// not match. Returns the existing vault id and its current scan status.
fn find_open_vault_by_canonical_path(
    vaults: &std::collections::HashMap<String, OpenVault>,
    incoming: &std::path::Path,
) -> Option<(String, ScanStatusBackend)> {
    vaults.iter().find_map(|(id, ov)| {
        let root = std::fs::canonicalize(ov.vault.root()).ok()?;
        (root.as_path() == incoming).then(|| (id.clone(), ov.scan_status))
    })
}

/// Open the vault at `req.path` and start its initial scan.
///
/// Returns immediately — the scan runs as a background task whose
/// progress is streamed via `vault:scan-progress` events. Per
/// `docs/layer-0-spec.md` §1, this resolves within 100ms regardless of
/// vault size.
pub async fn open_vault(
    state: &AppState,
    app: &AppHandle,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    // Idempotent re-open: if this folder is already open in-process,
    // return the existing session rather than constructing a second
    // Vault (and a second Tantivy IndexWriter) on the same directory,
    // which throws LockBusy. Identity is the canonical path; a failed
    // canonicalize (missing path, etc.) falls through to Vault::open,
    // which reports the proper VaultError.
    if let Ok(incoming) = std::fs::canonicalize(&req.path) {
        let guard = state.vaults().read().await;
        if let Some((existing_id, status)) = find_open_vault_by_canonical_path(&guard, &incoming) {
            return Ok(OpenVaultResponse {
                vault_id: existing_id,
                scan_status: status.into(),
            });
        }
    }

    let vault = Vault::open(&req.path).await?;
    let vault_id = state.new_vault_id();
    let cancel = CancellationToken::new();

    // Start the watcher *before* registering the vault, so a watcher
    // failure doesn't leave a half-initialized OpenVault in state.
    let (watch_tx, watch_rx) = mpsc::channel::<WatchEvent>(WATCHER_CHANNEL_DEPTH);
    let watcher = start_watcher(&vault, cancel.clone(), watch_tx)?;

    // Durable settings live in <vault>/.cubical/config.toml (source of
    // truth). A missing file ⇒ defaults; a malformed file ⇒ start empty
    // and log (never block open).
    let settings = cubical_core::vault::settings::load(vault.root()).unwrap_or_else(|e| {
        tracing::warn!("settings load failed, using defaults: {e}");
        cubical_core::vault::settings::SettingsMap::new()
    });

    let open = OpenVault::new(
        vault.clone(),
        cancel.clone(),
        ScanStatusBackend::InProgress,
        Some(watcher),
        settings,
    );
    let flush_own_writes = open.flush_own_writes.clone();
    let flush_in_progress = open.flush_in_progress.clone();
    let flush_timer_cancel = open.flush_timer_cancel.clone();
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
    );

    // L3 Session J — per-vault periodic flush timer. Cancelled in
    // close_vault before the close-time flush runs.
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

/// Cancel an in-flight scan. Idempotent — calling on a finished or
/// already-cancelled vault is a no-op.
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

/// Return summary metadata for an open vault.
///
/// Safe to call during scan; counts reflect what's been discovered so far.
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

/// List files tracked in the vault, with optional pagination.
pub async fn list_files(
    state: &AppState,
    req: ListFilesRequest,
) -> Result<ListFilesResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    // Pagination uses i64 since libsql binds integers as i64. u32::MAX
    // converts losslessly.
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

    Ok(ListFilesResponse {
        files,
        total: clamp_to_u32(total),
    })
}

/// Read the parsed frontmatter index for one file.
///
/// Reads from the `frontmatter` table populated by the scanner and
/// the watcher dispatcher; never re-parses the on-disk markdown.
/// Returns [`CubicalError::FileNotFound`] if the file isn't tracked
/// in the vault's `files` table.
///
/// Empty `entries` is a valid response: the file exists in the
/// index but has no YAML frontmatter, or its frontmatter was
/// malformed and was logged but not indexed.
pub async fn get_frontmatter(
    state: &AppState,
    req: GetFrontmatterRequest,
) -> Result<GetFrontmatterResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    // Existence check against `files`. Cheap — primary-key lookup.
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
        // Stored values are JSON-encoded by the writer. A parse
        // failure here means the writer side regressed; surface as
        // a string so the frontend doesn't lose data.
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

/// Read a markdown file's UTF-8 text contents from disk.
///
/// Coarse-grained on purpose: callers don't have to re-issue
/// `get_vault_info` or check `type_id` separately — the handler does
/// the existence + type check, then reads. Binary files are rejected
/// with [`CubicalError::InvalidRequest`] so the editor surface never
/// receives non-text bytes.
///
/// Returns:
/// - [`CubicalError::VaultNotOpen`] if `vault_id` is unknown.
/// - [`CubicalError::FileNotFound`] if `path` is not in `files`.
/// - [`CubicalError::InvalidRequest`] if the file's `type_id` is not
///   `"markdown"`.
/// - [`CubicalError::Io`] if the on-disk read fails (file vanished
///   since the index row, permission denied, invalid UTF-8, ...).
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

    // Disk I/O off the async executor.
    let on_disk = tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs_path))
        .await
        .map_err(|e| CubicalError::Io(format!("read task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    // L3 Session J (chain 3): materialize pending rewrites so the editor
    // view reflects post-rename links / tags / block-ids before the
    // pending-rewrites queue flushes to disk. No-op when the queue is
    // empty for this path. See `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`
    // "Read-path integration (materialize-on-read invariant)".
    let content =
        cubical_core::vault::pending::materialize_on_read(vault.index(), &req.path, &on_disk)
            .await?;

    Ok(ReadFileTextResponse { content })
}

/// Write a markdown file's UTF-8 text contents to disk atomically.
///
/// Coarse-grained "overwrite this file's body." Per `docs/layer-2-spec.md`
/// §2.1 + §3.1:
///
/// - Markdown-only: rejected with `InvalidRequest` if the indexed
///   `type_id` isn't `"markdown"`.
/// - Atomic: writes through `cubical_core::atomic_write` (temp-file +
///   fsync + rename) inside `spawn_blocking` so the async executor
///   isn't stalled by `fsync`.
/// - Hash returned: the SHA-256 of `req.content` is recomputed, stored
///   in the `files` row, and returned so the editor can populate
///   `last_written_hash` for hash-gating (§2.8).
/// - `expected_seen_hash` is advisory in L2: if it's `Some` and doesn't
///   match the current on-disk hash, the write still proceeds (the
///   user's "Keep my edits" choice from §2.7) but an `audit_log` row
///   is written at level `warn` with category `external_edit_override`
///   carrying both the expected and actual hashes.
///
/// Side effects: writes one of two `audit_log` rows.
/// - On success: category `autosave`, level `info`,
///   `{ path, bytes, new_content_hash }`.
/// - On override: an additional category `external_edit_override`,
///   level `warn`, `{ path, expected, actual }` row written before
///   the autosave row.
///
/// Returns:
/// - `VaultNotOpen` if `vault_id` is unknown.
/// - `FileNotFound` if `path` is not in `files`.
/// - `InvalidRequest` if the file's `type_id` is not `"markdown"`.
/// - `Io` if the atomic write or post-write metadata read fails.
pub async fn write_file_text(
    state: &AppState,
    req: WriteFileTextRequest,
) -> Result<WriteFileTextResponse, CubicalError> {
    // Look up + type-check + capture abs path while holding the read
    // lock, then drop the lock for the (blocking) write.
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

    // Atomic write off the async executor. `atomic_write` is sync (sync
    // I/O + sync rename + retry loop); pushing it through
    // spawn_blocking keeps the runtime responsive.
    let abs_for_write = abs_path.clone();
    let content_for_write = req.content.into_bytes();
    tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, &content_for_write))
        .await
        .map_err(|e| CubicalError::Io(format!("write task join error: {e}")))??;

    // Post-write metadata: the watcher will eventually fire and refresh
    // the files row independently. We update it eagerly here so the
    // editor's response carries the right mtime and the row stays in
    // sync even if the watcher event is racing or filtered.
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

        // External-edit override audit row first: if the editor handed
        // us a seen_hash and the on-disk hash diverged from it, the
        // user clicked "Keep my edits" knowing they were overwriting.
        // Audit before mutating the row so the breadcrumb survives even
        // if the upsert below fails.
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

/// Read one vault-local setting from the `config` table.
///
/// Per `docs/layer-2-spec.md` §2.6 + §3.2: the `config` table is a
/// generic `key TEXT PRIMARY KEY, value TEXT NOT NULL` store created by
/// the L0 migration. Values are JSON-encoded so non-string types
/// round-trip; this handler `serde_json::from_str`s on the way out.
///
/// Returns:
/// - `value: None` when the key is absent from the table. A stored
///   JSON `null` is `value: Some(Value::Null)` — distinct from missing.
/// - [`CubicalError::VaultNotOpen`] if `vault_id` is unknown.
/// - [`CubicalError::InvalidRequest`] if the stored value is not valid
///   JSON (a corrupt row — surfaced rather than panicked on).
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
    // workspace (`ui.*`) keys fall through to the DB read below.

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

/// Write one vault-local setting.
///
/// Routing: durable (non-`ui.*`) keys are written to
/// `.cubical/config.toml` via an atomic fsync + rename in a
/// `spawn_blocking` task (the file I/O is synchronous). `ui.*` workspace
/// keys upsert the DB `config` table — those are session-local layout
/// state that must not be committed to the portable vault file.
///
/// Returns:
/// - [`CubicalError::VaultNotOpen`] if `vault_id` is unknown.
/// - [`CubicalError::InvalidRequest`] if the `config.toml` save fails.
/// - [`CubicalError::Db`] if the DB upsert fails.
pub async fn set_setting(
    state: &AppState,
    req: SetSettingRequest,
) -> Result<SetSettingResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    if !cubical_core::vault::settings::is_workspace_key(&req.key) {
        // Clone the handles we need, then drop the vaults read guard
        // before acquiring the settings write lock and before running
        // the blocking file I/O — avoids holding the read guard across
        // either a write lock or a blocking syscall.
        let settings = Arc::clone(&open.settings);
        let root = open.vault.root().to_path_buf();
        drop(guard);

        let snapshot = {
            let mut map = settings.write().await;
            map.insert(req.key.clone(), req.value.clone());
            map.clone()
        }; // settings write lock released here

        tokio::task::spawn_blocking(move || cubical_core::vault::settings::save(&root, &snapshot))
            .await
            .map_err(|e| CubicalError::InvalidRequest(format!("settings save task panicked: {e}")))?
            .map_err(|e| CubicalError::InvalidRequest(format!("save settings: {e}")))?;

        return Ok(SetSettingResponse {});
    }
    // workspace (`ui.*`) keys fall through to the DB upsert below.

    let conn = open.vault.index().connection();

    // `serde_json::Value` always serializes, so this never fails in
    // practice — the `?` keeps it honest without an `expect`.
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

/// Read a markdown file from disk and parse it into the canonical AST.
///
/// Backed by `cubical_ast::parse`. The editor produces the same shape
/// from its Lezer tree (in `ui/src/ast/normalize.ts`); this command
/// is the authoritative-on-disk view, useful for indexers, exporters,
/// and tests that don't want to spin up a CodeMirror instance.
///
/// Pre-L7 the AST is recomputed on every call — there is no AST
/// cache table. The frontmatter index is the only AST-derived
/// storage at L1.
///
/// Returns:
/// - [`CubicalError::VaultNotOpen`] if `vault_id` is unknown.
/// - [`CubicalError::FileNotFound`] if `path` is not in `files`.
/// - [`CubicalError::InvalidRequest`] if the file's `type_id` is not
///   `"markdown"`.
/// - [`CubicalError::Io`] if the on-disk read fails.
pub async fn get_canonical_ast(
    state: &AppState,
    req: GetCanonicalAstRequest,
) -> Result<GetCanonicalAstResponse, CubicalError> {
    // Reuse the same disk-fetch path so the type check + I/O behavior
    // stays in one place.
    let ReadFileTextResponse { content } = read_file_text(
        state,
        ReadFileTextRequest {
            vault_id: req.vault_id,
            path: req.path,
        },
    )
    .await?;

    // Parsing is CPU-bound; keep it off the async executor.
    let document = tokio::task::spawn_blocking(move || cubical_ast::parse(&content))
        .await
        .map_err(|e| CubicalError::Io(format!("parse task join error: {e}")))?;

    Ok(GetCanonicalAstResponse { document })
}

/// Re-read `.cubical/config.toml` into the in-memory map (the file is the
/// source of truth) and return the resolved settings. For picking up edits
/// made to the file outside Cubical.
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

/// Cancel any in-flight scan and remove the vault from session state.
///
/// Drops the underlying `IndexConn` (and therefore the libSQL connection)
/// when the last reference goes away — Vault clones inside the scan task
/// keep the connection alive until the scan settles.
pub async fn close_vault<R: crate::events::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    req: CloseVaultRequest,
) -> Result<(), CubicalError> {
    let removed = {
        let mut guard = state.vaults().write().await;
        guard.remove(&req.vault_id)
    };
    let Some(open) = removed else {
        return Err(CubicalError::VaultNotOpen(req.vault_id));
    };

    // Bring the periodic flush timer down BEFORE running the close-time
    // flush, so the two don't race for `flush_in_progress`.
    open.flush_timer_cancel.cancel();

    // L3 Session J — mandatory close-time flush. Errors are logged and
    // swallowed so flush failure doesn't block close (rows survive on
    // disk for the next open).
    crate::commands::rename::flush_at_close(
        &open.vault,
        &open.flush_own_writes,
        &open.flush_in_progress,
        app,
        &req.vault_id,
    )
    .await;

    open.cancel.cancel();
    // Drop `open` here; the dispatcher task observes cancellation via
    // its CancellationToken clone and tears itself down. Last reference
    // to the IndexConn is in the scan task — once it exits, the DB is
    // closed.
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
    //! Pure-handler tests for the L1 `get_frontmatter` surface. The
    //! L0 commands (`open_vault`, `list_files`, ...) are exercised
    //! through the smoke pass against `cargo tauri dev`; here we
    //! cover the new fallible paths that can regress silently.
    //!
    //! Each test builds an `AppState`, drops a manually-constructed
    //! `OpenVault` into it (no Tauri runtime needed), and calls the
    //! pure handler directly.
    use super::*;
    use cubical_core::Vault;
    use tempfile::tempdir;

    /// Build an `AppState` carrying one fresh vault under `vault_id`,
    /// returning the temp dir (so its lifetime extends past the test
    /// body) and the vault for direct DB inspection.
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
        // `incoming` is canonicalized the way open_vault canonicalizes req.path.
        let incoming = std::fs::canonicalize(dir.path()).unwrap();
        let guard = state.vaults().read().await;
        let found = find_open_vault_by_canonical_path(&guard, &incoming);
        assert_eq!(found, Some(("v1".to_string(), ScanStatusBackend::Complete)));
    }

    #[tokio::test]
    async fn reopen_different_path_returns_none() {
        let (_dir_a, _vault_a, state) = fresh_state_with_vault("v1").await;
        // A directory that is NOT registered in state.
        let dir_b = tempdir().unwrap();
        let incoming = std::fs::canonicalize(dir_b.path()).unwrap();
        let guard = state.vaults().read().await;
        assert_eq!(find_open_vault_by_canonical_path(&guard, &incoming), None);
    }

    /// Insert a `files` row + a couple of `frontmatter` rows for
    /// `path` so `get_frontmatter` has something to return.
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

    /// Insert a `files` row whose `path` exists on disk relative to
    /// `vault.root()`. Writes `body` to that path so the read commands
    /// have something to fetch.
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
        // L3 Session J (chain 3): a pending wiki-link rewrite for the
        // open file must show up in the editor's read view BEFORE the
        // flush.
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
        // Returned content is materialized — the editor sees [[Journal]].
        assert_eq!(resp.content, "see [[Journal]] for context\n");
        // The on-disk bytes are untouched until the flush.
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

    // -- write_file_text --------------------------------------------------

    /// Fetch the most recent audit_log row for inspection.
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

        // On-disk content matches buffer byte-for-byte.
        let on_disk = std::fs::read_to_string(vault.root().join("note.md")).unwrap();
        assert_eq!(on_disk, new);

        // Returned hash matches SHA-256 of the buffer.
        assert_eq!(
            resp.new_content_hash,
            cubical_core::sha256_bytes_hex(new.as_bytes())
        );

        // files row is updated with the new hash.
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
        // Seed with a row but a content_hash that won't match the
        // editor's expected_seen_hash.
        seed_file_on_disk(&vault, "note.md", "current\n", "markdown").await;
        // Force a non-empty current hash so the mismatch is meaningful.
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

        // Both rows should exist — query each category separately so
        // the assertion doesn't depend on rowid ordering.
        let conn = vault.index().connection();

        // Autosave row.
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

        // Override row.
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

        // Only the autosave row should land — no override row.
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

    // -- get_setting / set_setting ---------------------------------------

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
        // A stored JSON null is `Some(Null)` — distinct from an absent
        // key, which returns `None`.
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
        // Write a corrupt row directly into the DB under a `ui.*`
        // workspace key (the only path that still reads the DB now that
        // non-workspace keys route to the in-memory TOML-backed map).
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

        // First open: write a setting, then drop the whole state so
        // the libSQL connection closes — `index.db` on disk is the
        // only thing that survives into the second open.
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

        // Second open against the same path: fresh AppState, fresh
        // Vault. Settings now persist via .cubical/config.toml — load
        // them the same way open_vault does.
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

    // -- file-backed settings (Tasks 1.7 + 1.8) -------------------------

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

        // A ui.* workspace key must NOT land in the file.
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

        // Write the file directly (as an external editor would).
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
        // And the in-memory map now serves it.
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
}
