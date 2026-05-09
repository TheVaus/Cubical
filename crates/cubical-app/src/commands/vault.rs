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

use cubical_core::{start_watcher, Vault, WatchEvent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::api::types::{
    CancelVaultScanRequest, CloseVaultRequest, FileEntry, FrontmatterEntry, GetCanonicalAstRequest,
    GetCanonicalAstResponse, GetFrontmatterRequest, GetFrontmatterResponse, GetVaultInfoRequest,
    GetVaultInfoResponse, ListFilesRequest, ListFilesResponse, OpenVaultRequest, OpenVaultResponse,
    ReadFileTextRequest, ReadFileTextResponse, ScanStatus,
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
    let vault = Vault::open(&req.path).await?;
    let vault_id = state.new_vault_id();
    let cancel = CancellationToken::new();

    // Start the watcher *before* registering the vault, so a watcher
    // failure doesn't leave a half-initialized OpenVault in state.
    let (watch_tx, watch_rx) = mpsc::channel::<WatchEvent>(WATCHER_CHANNEL_DEPTH);
    let watcher = start_watcher(&vault, cancel.clone(), watch_tx)?;

    let open = OpenVault {
        vault: vault.clone(),
        cancel: cancel.clone(),
        scan_status: ScanStatusBackend::InProgress,
        watcher: Some(watcher),
    };
    state.vaults().write().await.insert(vault_id.clone(), open);

    spawn_scan_dispatcher(
        app.clone(),
        state.vaults_arc(),
        vault_id.clone(),
        vault.clone(),
        cancel,
    );

    spawn_watcher_dispatcher(app.clone(), vault_id.clone(), vault, watch_rx);

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
    let abs_path = {
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
        open.vault.root().join(&req.path)
    };

    // Disk I/O off the async executor.
    let content = tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs_path))
        .await
        .map_err(|e| CubicalError::Io(format!("read task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    Ok(ReadFileTextResponse { content })
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

/// Cancel any in-flight scan and remove the vault from session state.
///
/// Drops the underlying `IndexConn` (and therefore the libSQL connection)
/// when the last reference goes away — Vault clones inside the scan task
/// keep the connection alive until the scan settles.
pub async fn close_vault(state: &AppState, req: CloseVaultRequest) -> Result<(), CubicalError> {
    let removed = {
        let mut guard = state.vaults().write().await;
        guard.remove(&req.vault_id)
    };
    let Some(open) = removed else {
        return Err(CubicalError::VaultNotOpen(req.vault_id));
    };
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
            OpenVault {
                vault: vault.clone(),
                cancel: tokio_util::sync::CancellationToken::new(),
                scan_status: ScanStatusBackend::Complete,
                watcher: None,
            },
        );
        (dir, vault, state)
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
}
