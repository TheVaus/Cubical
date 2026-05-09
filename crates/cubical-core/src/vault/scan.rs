//! Non-blocking vault scan.
//!
//! Walks the vault tree, dispatches each file through the
//! [`FileTypeRegistry`](crate::file_type::FileTypeRegistry), computes a
//! content hash via the matching handler, and upserts a row into the
//! `files` table. Progress is streamed back via an
//! [`mpsc::Sender<ScanProgress>`] so callers can forward to whatever
//! transport they want (a Tauri event in the app crate, a test channel
//! in unit tests). Cancellation is cooperative and is checked between
//! files — `tokio_util::sync::CancellationToken` is the contract.

use std::time::SystemTime;

use libsql::params;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::vault::{frontmatter::refresh_frontmatter, Vault, VaultError};

/// Progress update streamed from an in-flight scan.
///
/// `files_total_estimate` is a rolling lower-bound: it is the count of
/// regular-file entries the walker has *seen so far* (not the final
/// total). It converges to the true total as the walk completes.
#[derive(Debug, Clone, Copy)]
pub struct ScanProgress {
    /// Files that have been hashed and persisted to the index.
    pub files_processed: u32,
    /// Rolling lower-bound estimate of the total file count.
    pub files_total_estimate: u32,
}

/// Scan `vault` and upsert every tracked file into the `files` table.
///
/// On success returns the final processed-file count. On cancellation
/// returns [`VaultError::ScanCancelled`]; partial work already committed
/// is left in place so a re-scan can resume cleanly. Other I/O or hash
/// failures on individual files are logged and skipped — they don't
/// abort the whole scan.
///
/// The progress channel is best-effort: if the receiver is dropped (e.g.
/// the dispatcher task already exited), updates are silently discarded
/// rather than failing the scan.
pub async fn scan(
    vault: Vault,
    cancel: CancellationToken,
    progress: mpsc::Sender<ScanProgress>,
) -> Result<u32, VaultError> {
    let root = vault.root().to_path_buf();
    let registry = vault.registry_arc();

    let mut files_processed: u32 = 0;
    let mut files_total_estimate: u32 = 0;

    let walker = WalkDir::new(&root).follow_links(false).into_iter();
    let walker = walker.filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        if !entry.file_type().is_dir() {
            return true;
        }
        let name = entry.file_name().to_string_lossy();
        if name == "node_modules" {
            return false;
        }
        // Skip dot-prefixed directories. This catches `.cubical/`, `.git/`,
        // `.idea/`, `.obsidian/`, `.DS_Store/` (rare but possible), etc.
        !name.starts_with('.')
    });

    for entry_result in walker {
        if cancel.is_cancelled() {
            tracing::info!(processed = files_processed, "scan cancelled mid-walk");
            return Err(VaultError::ScanCancelled);
        }

        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "walkdir entry error; skipping");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }

        let abs_path = entry.path().to_path_buf();
        let rel_path = abs_path
            .strip_prefix(&root)
            .unwrap_or(&abs_path)
            .to_path_buf();
        files_total_estimate = files_total_estimate.saturating_add(1);

        let Some(handler) = registry.handler_for(&abs_path) else {
            // No registered handler claimed this path. With the default
            // registry (markdown + binary catch-all) this never fires;
            // custom registries that omit the catch-all will see it.
            continue;
        };
        let type_id = handler.type_id();

        let metadata = match std::fs::metadata(&abs_path) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(path = %abs_path.display(), error = %e, "metadata read failed; skipping");
                continue;
            }
        };

        // Hash off the executor — large files would otherwise stall the
        // runtime. Re-dispatch through the registry inside the blocking
        // task so we don't have to make handlers `Clone`.
        let abs_for_hash = abs_path.clone();
        let registry_for_hash = registry.clone();
        let hash_result = tokio::task::spawn_blocking(move || {
            let handler = registry_for_hash
                .handler_for(&abs_for_hash)
                .expect("handler matched in foreground; same registry, same path");
            handler.content_hash(&abs_for_hash)
        })
        .await;

        let content_hash = match hash_result {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                tracing::warn!(path = %abs_path.display(), error = %e, "content hash failed; skipping");
                continue;
            }
            Err(join_err) => {
                tracing::warn!(path = %abs_path.display(), error = %join_err, "hash task join failed; skipping");
                continue;
            }
        };

        let now_secs = unix_now_secs();
        let size_bytes = clamp_to_i64(metadata.len());
        let mtime_unix = mtime_secs(&metadata);
        let inode = inode_of(&metadata);

        // UPSERT keyed on path. `created_at` is intentionally omitted from
        // the conflict update so the original creation time survives a
        // re-scan; everything else is overwritten with the latest values.
        let path_str = rel_path.to_string_lossy().into_owned();
        let upsert = "
            INSERT INTO files (
                path, type_id, size_bytes, mtime_unix, content_hash,
                inode, last_seen, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
            ON CONFLICT(path) DO UPDATE SET
                type_id      = excluded.type_id,
                size_bytes   = excluded.size_bytes,
                mtime_unix   = excluded.mtime_unix,
                content_hash = excluded.content_hash,
                inode        = excluded.inode,
                last_seen    = excluded.last_seen,
                updated_at   = excluded.last_seen
        ";
        let conn = vault.index().connection();
        if let Err(e) = conn
            .execute(
                upsert,
                params![
                    path_str.clone(),
                    type_id,
                    size_bytes,
                    mtime_unix,
                    content_hash,
                    inode,
                    now_secs,
                ],
            )
            .await
        {
            tracing::warn!(path = %abs_path.display(), error = %e, "files upsert failed; skipping");
            continue;
        }

        // L1: refresh the `frontmatter` rows for markdown files. Other
        // file types skip — frontmatter is a markdown-only concept.
        // Errors are logged and ignored: the `files` row is in place,
        // so a malformed YAML file is still tracked, just without a
        // frontmatter index. The next scan or modify event will heal
        // it if the file gets fixed.
        if type_id == "markdown" {
            if let Err(e) = refresh_frontmatter(&vault, &abs_path, &path_str).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "frontmatter refresh failed");
            }
        }

        files_processed = files_processed.saturating_add(1);

        let _ = progress
            .send(ScanProgress {
                files_processed,
                files_total_estimate,
            })
            .await;
    }

    tracing::info!(processed = files_processed, "scan complete");
    Ok(files_processed)
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| clamp_to_i64(d.as_secs()))
        .unwrap_or(0)
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| clamp_to_i64(d.as_secs()))
        .unwrap_or(0)
}

fn clamp_to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

#[cfg(unix)]
fn inode_of(meta: &std::fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    Some(clamp_to_i64(meta.ino()))
}

#[cfg(not(unix))]
fn inode_of(_meta: &std::fs::Metadata) -> Option<i64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsql::Value;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::time::Duration;
    use tempfile::tempdir;

    /// Build a vault containing `n` markdown files and `extras` (relative path → bytes).
    async fn fixture_vault(n: usize, extras: &[(&str, &[u8])]) -> (tempfile::TempDir, Vault) {
        let dir = tempdir().unwrap();
        for i in 0..n {
            let p = dir.path().join(format!("note-{i:03}.md"));
            fs::write(&p, format!("body of note {i}\n")).unwrap();
        }
        for (rel, bytes) in extras {
            let p = dir.path().join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, bytes).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open");
        (dir, vault)
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut s = String::with_capacity(digest.len() * 2);
        for b in digest.iter() {
            use std::fmt::Write as _;
            let _ = write!(s, "{b:02x}");
        }
        s
    }

    async fn scalar_i64(vault: &Vault, sql: &str) -> i64 {
        let conn = vault.index().connection();
        let mut rows = conn.query(sql, ()).await.expect("query");
        let row = rows.next().await.expect("next").expect("row");
        row.get::<i64>(0).expect("get")
    }

    #[tokio::test]
    async fn scan_inserts_a_row_per_file_without_modifying_content() {
        let (dir, vault) = fixture_vault(10, &[]).await;
        // Capture file content + hashes before scan.
        let mut before: Vec<(String, String)> = Vec::new();
        for i in 0..10 {
            let p = dir.path().join(format!("note-{i:03}.md"));
            let bytes = fs::read(&p).unwrap();
            before.push((format!("note-{i:03}.md"), sha256_hex(&bytes)));
        }

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();
        let count = scan(vault.clone(), cancel, tx).await.expect("scan");
        assert_eq!(count, 10);

        // 10 rows in `files`.
        assert_eq!(scalar_i64(&vault, "SELECT COUNT(*) FROM files").await, 10);
        // All `markdown` type_id.
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM files WHERE type_id = 'markdown'"
            )
            .await,
            10,
        );

        // Re-hash files after scan; verify the bytes weren't touched.
        for (rel, expected_hash) in before {
            let bytes = fs::read(dir.path().join(&rel)).unwrap();
            assert_eq!(sha256_hex(&bytes), expected_hash, "{rel} byte-changed");

            // And the stored hash matches.
            let conn = vault.index().connection();
            let mut rows = conn
                .query(
                    "SELECT content_hash FROM files WHERE path = ?1",
                    [rel.clone()],
                )
                .await
                .unwrap();
            let row = rows.next().await.unwrap().unwrap();
            let stored: String = row.get(0).unwrap();
            assert_eq!(stored, expected_hash, "{rel} stored hash mismatch");
        }
    }

    #[tokio::test]
    async fn scan_skips_dot_dirs_node_modules_and_cubical_internals() {
        let (_dir, vault) = fixture_vault(
            3,
            &[
                (".git/HEAD", b"ref: refs/heads/main\n"),
                (".obsidian/config.json", b"{}"),
                ("node_modules/foo/index.js", b"console.log()"),
                ("ok-binary.png", b"\x89PNG\r\n\x1a\n"),
            ],
        )
        .await;

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        // 3 markdown + 1 binary = 4. Nothing from .git/, .obsidian/, node_modules/.
        assert_eq!(scalar_i64(&vault, "SELECT COUNT(*) FROM files").await, 4);
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM files WHERE type_id = 'markdown'"
            )
            .await,
            3,
        );
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM files WHERE type_id = 'binary'"
            )
            .await,
            1,
        );
    }

    #[tokio::test]
    async fn scan_emits_at_least_one_progress_event_on_a_multi_file_vault() {
        let (_dir, vault) = fixture_vault(20, &[]).await;
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();
        let scan_handle = tokio::spawn(scan(vault, cancel, tx));

        let mut events = 0;
        let mut last: Option<ScanProgress> = None;
        while let Some(p) = rx.recv().await {
            events += 1;
            last = Some(p);
        }
        let count = scan_handle.await.unwrap().unwrap();
        assert_eq!(count, 20);
        assert!(events >= 1, "expected at least one progress event");
        let last = last.unwrap();
        assert_eq!(last.files_processed, 20);
        assert_eq!(last.files_total_estimate, 20);
    }

    #[tokio::test]
    async fn scan_cancels_within_100ms_of_signal_on_a_200_file_vault() {
        let (_dir, vault) = fixture_vault(200, &[]).await;
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();

        let scan_handle = tokio::spawn(scan(vault.clone(), cancel.clone(), tx));

        // Wait for the scan to actually start (first progress event).
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("first progress within 2s");

        // Cancel and time how long the scan task takes to settle.
        let t0 = std::time::Instant::now();
        cancel.cancel();
        // Drain remaining progress events so the scan task isn't blocked
        // on a full channel; this also lets the task observe cancellation
        // promptly.
        tokio::spawn(async move { while rx.recv().await.is_some() {} });

        let result = tokio::time::timeout(Duration::from_millis(500), scan_handle)
            .await
            .expect("scan task did not settle within 500ms");
        let elapsed = t0.elapsed();
        let inner = result.expect("scan task panicked");
        match inner {
            Err(VaultError::ScanCancelled) => {}
            // It's acceptable for the scan to have already finished if it
            // was extremely fast; in that case we do NOT count it as a
            // pass for cancellation responsiveness, so fail loudly.
            other => panic!("expected ScanCancelled, got {other:?}"),
        }

        assert!(
            elapsed <= Duration::from_millis(100),
            "cancel-to-settle was {elapsed:?}, expected <= 100ms",
        );

        // No orphan rows for un-scanned files: the count of rows in `files`
        // is bounded by what was scanned before the cancel — i.e. less than
        // the total of 200, but a non-negative number is acceptable.
        let row_count = scalar_i64(&vault, "SELECT COUNT(*) FROM files").await;
        assert!(
            (0..200).contains(&row_count),
            "expected partial row count in [0, 200), got {row_count}"
        );
    }

    #[tokio::test]
    async fn rescan_is_idempotent_and_preserves_created_at() {
        let (_dir, vault) = fixture_vault(5, &[]).await;
        let cancel = CancellationToken::new();

        // First scan.
        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), cancel.clone(), tx)
            .await
            .expect("scan1");
        let first_created: Vec<(String, i64)> = {
            let conn = vault.index().connection();
            let mut rows = conn
                .query("SELECT path, created_at FROM files ORDER BY path", ())
                .await
                .unwrap();
            let mut out = Vec::new();
            while let Some(row) = rows.next().await.unwrap() {
                let p: String = row.get(0).unwrap();
                let c: i64 = row.get(1).unwrap();
                out.push((p, c));
            }
            out
        };
        assert_eq!(first_created.len(), 5);

        // Sleep so the second scan would write a different `now_secs` if
        // it overwrote `created_at`. One second is the smallest unit.
        tokio::time::sleep(Duration::from_millis(1100)).await;

        // Second scan — same files, same paths.
        let (tx2, _rx2) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), cancel, tx2).await.expect("scan2");
        assert_eq!(scalar_i64(&vault, "SELECT COUNT(*) FROM files").await, 5);

        let second_created: Vec<(String, i64)> = {
            let conn = vault.index().connection();
            let mut rows = conn
                .query("SELECT path, created_at FROM files ORDER BY path", ())
                .await
                .unwrap();
            let mut out = Vec::new();
            while let Some(row) = rows.next().await.unwrap() {
                let p: String = row.get(0).unwrap();
                let c: i64 = row.get(1).unwrap();
                out.push((p, c));
            }
            out
        };
        assert_eq!(
            first_created, second_created,
            "created_at must be preserved"
        );
    }

    // Sanity check that libsql accepts `Option<i64>` for the inode
    // parameter on platforms that always supply Some.
    // -- Frontmatter wiring (L1) --------------------------------------

    /// Build a vault with `files` (relative path → bytes) explicitly
    /// listed. Useful when tests want a file with frontmatter without
    /// going through `fixture_vault`'s template body.
    async fn fixture_vault_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, Vault) {
        let dir = tempdir().unwrap();
        for (rel, bytes) in files {
            let p = dir.path().join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, bytes).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open");
        (dir, vault)
    }

    #[tokio::test]
    async fn scan_populates_frontmatter_rows_for_markdown_files() {
        let (_dir, vault) = fixture_vault_with(&[(
            "note.md",
            b"---\ntitle: Hello\ntags: [a, b]\nready: true\n---\n\nbody\n",
        )])
        .await;

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        let conn = vault.index().connection();
        // Three keys → three rows.
        assert_eq!(
            scalar_i64(&vault, "SELECT COUNT(*) FROM frontmatter").await,
            3
        );
        // Spot-check the JSON-encoded value for `tags`.
        let mut rows = conn
            .query(
                "SELECT value FROM frontmatter WHERE file_path = 'note.md' AND key = 'tags'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("tags row");
        let raw: String = row.get(0).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, serde_json::json!(["a", "b"]));
    }

    #[tokio::test]
    async fn scan_handles_malformed_frontmatter_without_failing() {
        let (_dir, vault) =
            fixture_vault_with(&[("broken.md", b"---\ntitle: : :\n  - bad\n---\n\nbody\n")]).await;

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan should succeed despite malformed YAML");

        // The `files` row is there.
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM files WHERE path = 'broken.md'"
            )
            .await,
            1
        );
        // No frontmatter rows for this file.
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM frontmatter WHERE file_path = 'broken.md'"
            )
            .await,
            0
        );
    }

    #[tokio::test]
    async fn rescan_drops_keys_removed_from_frontmatter() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        fs::write(&p, "---\ntitle: A\nstatus: draft\n---\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan1");
        assert_eq!(
            scalar_i64(&vault, "SELECT COUNT(*) FROM frontmatter").await,
            2
        );

        // User edits the file — drops `status`, renames `title`.
        fs::write(&p, "---\nheading: B\n---\n").unwrap();

        let (tx2, _rx2) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx2)
            .await
            .expect("scan2");
        assert_eq!(
            scalar_i64(&vault, "SELECT COUNT(*) FROM frontmatter").await,
            1
        );
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM frontmatter WHERE key = 'status'"
            )
            .await,
            0
        );
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM frontmatter WHERE key = 'heading'"
            )
            .await,
            1
        );
    }

    #[tokio::test]
    async fn scan_skips_frontmatter_for_non_markdown_files() {
        let (_dir, vault) = fixture_vault_with(&[
            ("note.md", b"---\ntitle: Hello\n---\nbody\n"),
            ("data.bin", b"---\ntitle: NotMarkdown\n---\n"),
        ])
        .await;

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        // Only the markdown file produces frontmatter rows.
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM frontmatter WHERE file_path = 'data.bin'"
            )
            .await,
            0
        );
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM frontmatter WHERE file_path = 'note.md'"
            )
            .await,
            1
        );
    }

    #[tokio::test]
    async fn inode_param_round_trips() {
        let (_dir, vault) = fixture_vault(1, &[]).await;
        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
        let conn = vault.index().connection();
        let mut rows = conn
            .query("SELECT inode FROM files LIMIT 1", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        // On Unix this is Some(_); on other platforms Null. Both are valid.
        let v = row.get_value(0).unwrap();
        assert!(matches!(v, Value::Integer(_) | Value::Null));
    }
}
