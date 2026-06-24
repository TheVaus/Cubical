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

use cubical_ast::Anchor;
use cubical_index::{
    replace_links_for_file, sweep_stale_folders, upsert_folder, IndexError, LinkRow,
};
use libsql::params;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::vault::{
    blocks::{refresh_block_refs_for_file, refresh_blocks},
    frontmatter::refresh_frontmatter,
    links::{extract_links_from_source, read_source_off_executor, LinkExtraction, PathResolver},
    pending::materialize_on_read,
    search_refresh::refresh_search_index,
    tags::refresh_tags,
    Vault, VaultError,
};

/// Number of files persisted per index transaction.
///
/// Autocommitting every file means one `fsync` per file — tens of
/// thousands of them on a large vault, which is the difference between
/// a scan that finishes in seconds and one that grinds for minutes.
/// Batching collapses that to one `fsync` per batch. A re-scan resumes
/// cleanly from the last committed batch.
const SCAN_BATCH_SIZE: u32 = 500;

/// Commit the Tantivy index every N docs during initial scan so the
/// writer's in-memory buffer stays bounded on large vaults.
const SEARCH_COMMIT_EVERY: usize = 5_000;

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

    // Captured before the walk: every file the walk upserts is stamped
    // with `last_seen >= scan_started_secs`. After the walk, rows still
    // carrying an older `last_seen` were not seen this scan — they were
    // deleted on disk while the app wasn't watching — and get swept.
    let scan_started_secs = unix_now_secs();

    let mut files_processed: u32 = 0;
    let mut files_total_estimate: u32 = 0;

    // Persist files in batched transactions rather than autocommitting
    // each one — see `SCAN_BATCH_SIZE`. `conn` is hoisted so the
    // transaction handle and the per-file upserts share it.
    let conn = vault.index().connection();
    let mut tx = conn.transaction().await.map_err(IndexError::from)?;
    let mut batch_count: u32 = 0;
    let mut search_batch_count: usize = 0;
    // Every markdown path indexed this scan — used to reconcile the
    // search index (drop docs for files renamed/deleted while the app
    // wasn't watching) once the walk is complete.
    let mut indexed_search_paths: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    // Pass-1 buffer: link occurrences per source file. Resolution is
    // deferred to Pass 2 (after the walk) so it sees the COMPLETE file
    // set — both for correctness (forward references) and to avoid the
    // O(N²) of re-loading the path set per file. See
    // docs/layer-3-spec.md §5.6.
    let mut pending_links: Vec<(String, Vec<LinkExtraction>)> = Vec::new();

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
            // Commit work done so far so a re-scan resumes cleanly.
            tx.commit().await.map_err(IndexError::from)?;
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
            // Record directories (other than the vault root) into the
            // `folders` table so empty ones still render in the tree.
            // Excluded dirs (dot-prefixed, `node_modules`) are already
            // pruned by the walker's `filter_entry` above, so anything
            // reaching here is a folder we want to track.
            if entry.file_type().is_dir() && entry.depth() > 0 {
                let rel = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .into_owned();
                if let Err(e) = upsert_folder(vault.index(), &rel, scan_started_secs).await {
                    tracing::warn!(path = %rel, error = %e, "folder upsert failed; skipping");
                }
            }
            continue;
        }
        // Skip atomic-write scratch files left behind by a crashed
        // write. Mirrors the watcher's same filter in
        // `watcher.rs::is_excluded` — both filters must agree.
        if entry.path().extension().is_some_and(|e| e == "cubical-tmp") {
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
        //
        // L3 Session J (chain 3): read the source ONCE per markdown file
        // and materialize any pending rewrites for `path_str`, then hand
        // the materialized text to every extractor. Otherwise scan-derived
        // tables (frontmatter, links, tags, blocks) reflect the *old*
        // tokens until flush — the user-visible editor view (which goes
        // through `materialize_on_read`) would disagree with backlinks +
        // tag listings. (`files.content_hash` is computed against the
        // raw on-disk bytes above and intentionally untouched here — it
        // tracks the unrewritten file.)
        if type_id == "markdown" {
            let raw_source = read_source_off_executor(&abs_path)
                .await
                .unwrap_or_default();
            let source = match materialize_on_read(vault.index(), &path_str, &raw_source).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(path = %abs_path.display(), error = %e, "materialize_on_read failed; using raw source");
                    raw_source
                }
            };

            if let Err(e) = refresh_frontmatter(&vault, &path_str, &source).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "frontmatter refresh failed");
            }
            // L3 §5.6: defer link RESOLUTION to Pass 2; just extract +
            // buffer here. Extraction still parses the file (the §5.5
            // multi-parse is a separate, deferred issue).
            let extractions = extract_links_from_source(&source).await;
            if !extractions.is_empty() {
                pending_links.push((path_str.clone(), extractions));
            }
            // L3 Session D: refresh the `tags` rows. Same resilience
            // policy — inline + frontmatter tags feed one table.
            if let Err(e) = refresh_tags(&vault, &path_str, &source).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "tags refresh failed");
            }
            // L3 §2.7: block-id definitions are per-file (no resolution),
            // so they refresh inline here alongside frontmatter + tags.
            if let Err(e) = refresh_blocks(&vault, &path_str, &source).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "blocks refresh failed");
            }
            // L4-A: search index refresh. Same resilience policy as the
            // others — log on error, do not abort the scan.
            //
            // Cancellation guard: the search refresher is the heaviest
            // per-file refresher (parse + project + IndexWriter mutation).
            // Skip it if cancellation is already in flight so the 100ms
            // cancellation budget holds under parallel test load. The
            // next launch's scan re-walks every file and upsert is
            // idempotent (delete-by-path then add), so a file skipped
            // mid-scan converges on the next pass — its libSQL refreshers
            // (frontmatter / links / tags / blocks) already ran in this
            // iteration, but the search doc will be re-projected next time.
            if !cancel.is_cancelled() {
                let search_size_bytes = source.len() as u64;
                if let Err(e) =
                    refresh_search_index(&vault, &path_str, &source, mtime_unix, search_size_bytes)
                        .await
                {
                    tracing::warn!(path = %abs_path.display(), error = %e, "search index refresh failed");
                }
                indexed_search_paths.insert(path_str.clone());
                search_batch_count += 1;
                if search_batch_count >= SEARCH_COMMIT_EVERY {
                    if let Err(e) = vault.search().commit() {
                        tracing::warn!(error = %e, "search index periodic commit failed");
                    }
                    search_batch_count = 0;
                }
            }
        }

        files_processed = files_processed.saturating_add(1);

        // Commit and reopen once the batch fills, so the work lands on
        // disk incrementally rather than in one transaction at the end.
        batch_count += 1;
        if batch_count >= SCAN_BATCH_SIZE {
            tx.commit().await.map_err(IndexError::from)?;
            tx = conn.transaction().await.map_err(IndexError::from)?;
            batch_count = 0;
        }

        let _ = progress
            .send(ScanProgress {
                files_processed,
                files_total_estimate,
            })
            .await;
    }

    // Commit Pass 1 so the files table is complete and visible to the
    // resolution query below.
    tx.commit().await.map_err(IndexError::from)?;

    // L4-A: final search commit so the scan's last batch is queryable.
    if let Err(e) = vault.search().commit() {
        tracing::warn!(error = %e, "search index final commit failed");
    }

    // L4-B: reconcile the search index with the on-disk file set — drop
    // docs for markdown files renamed or deleted while the app wasn't
    // watching (no watcher event fired), which would otherwise surface
    // stale hits. Skip under cancellation: the walk is incomplete, so
    // `indexed_search_paths` is partial and would wrongly drop live docs.
    if !cancel.is_cancelled() {
        match vault.search().retain_paths(&indexed_search_paths) {
            Ok(removed) if removed > 0 => {
                if let Err(e) = vault.search().commit() {
                    tracing::warn!(error = %e, "search index reconcile commit failed");
                } else {
                    tracing::info!(removed, "search index reconciled (dropped orphan docs)");
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "search index reconcile failed"),
        }
    }

    // Sweep `files` rows for paths deleted while the app wasn't watching.
    // Pass 1 stamped every on-disk file with `last_seen >= scan_started_secs`;
    // anything still older vanished from disk and must leave the index so
    // it stops surfacing in `list_files` / the tree. The `ON DELETE CASCADE`
    // FKs carry each gone file's outbound rows with it. Mirrors the search
    // reconcile above; skipped under cancellation, where the walk is
    // incomplete and live rows would look stale.
    if !cancel.is_cancelled() {
        match conn
            .execute(
                "DELETE FROM files WHERE last_seen < ?1",
                params![scan_started_secs],
            )
            .await
        {
            Ok(n) if n > 0 => tracing::info!(removed = n, "scan swept rows for deleted files"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "files sweep failed"),
        }

        // Same sweep for the `folders` table: a directory deleted while
        // the app wasn't watching keeps a row whose `last_seen` predates
        // this scan, so drop it. Folders are tracked only so empty ones
        // stay visible; a stale row would show a ghost folder in the tree.
        match sweep_stale_folders(vault.index(), scan_started_secs).await {
            Ok(n) if n > 0 => tracing::info!(removed = n, "scan swept rows for deleted folders"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "folders sweep failed"),
        }
    }

    // ---- Pass 2: resolve all buffered links against the complete file
    // set, once. O(N) build + O(1) common-case lookups. Replaces the
    // old O(N²) per-file resolve. See docs/layer-3-spec.md §5.6.
    let known_paths = {
        let mut rows = conn
            .query("SELECT path FROM files ORDER BY path", ())
            .await
            .map_err(IndexError::from)?;
        let mut v = Vec::new();
        while let Some(row) = rows.next().await.map_err(IndexError::from)? {
            v.push(row.get::<String>(0).map_err(IndexError::from)?);
        }
        v
    };
    let resolver = PathResolver::build(known_paths);

    let mut link_tx = conn.transaction().await.map_err(IndexError::from)?;
    let mut link_batch: u32 = 0;
    for (source_path, extractions) in pending_links {
        if cancel.is_cancelled() {
            link_tx.commit().await.map_err(IndexError::from)?;
            return Err(VaultError::ScanCancelled);
        }
        let rows: Vec<LinkRow> = extractions
            .into_iter()
            .map(|e| {
                let target_path = resolver.resolve(&e.target_raw);
                let (anchor_kind, anchor_value) = match e.anchor {
                    Some(Anchor::Heading { value }) => (Some("heading".to_string()), Some(value)),
                    Some(Anchor::Block { value }) => (Some("block".to_string()), Some(value)),
                    None => (None, None),
                };
                LinkRow {
                    target_raw: e.target_raw,
                    target_path,
                    anchor_kind,
                    anchor_value,
                    display_text: e.display,
                    is_embed: e.is_embed,
                    position: e.position,
                }
            })
            .collect();
        if let Err(e) = replace_links_for_file(vault.index(), &source_path, &rows).await {
            tracing::warn!(path = %source_path, error = %e, "links resolve/write failed");
        }
        // L3 §2.7: now that this source's resolved links are persisted,
        // project its block-anchored ones into the block_refs table.
        if let Err(e) = refresh_block_refs_for_file(&vault, &source_path).await {
            tracing::warn!(path = %source_path, error = %e, "block_refs refresh failed");
        }
        link_batch += 1;
        if link_batch >= SCAN_BATCH_SIZE {
            link_tx.commit().await.map_err(IndexError::from)?;
            link_tx = conn.transaction().await.map_err(IndexError::from)?;
            link_batch = 0;
        }
    }
    link_tx.commit().await.map_err(IndexError::from)?;

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
    async fn scan_indexes_every_markdown_file_for_search() {
        use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
        let n = 60usize;
        let dir = tempdir().unwrap();
        for i in 0..n {
            let p = dir.path().join(format!("note-{i:03}.md"));
            fs::write(&p, format!("# Title {i}\n\nzzqx{i:03} body content\n")).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open");
        let (tx, _rx) = mpsc::channel::<ScanProgress>(256);
        let cancel = CancellationToken::new();
        let count = scan(vault.clone(), cancel, tx).await.expect("scan");
        assert_eq!(count as usize, n);
        assert_eq!(
            vault.search().doc_count().unwrap(),
            n as u64,
            "every markdown file must land in the search index"
        );
        for i in 0..n {
            let q = SearchQuery {
                text: format!("zzqx{i:03}"),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            };
            let r = run_search(vault.search(), &q).unwrap();
            assert_eq!(
                r.hits.len(),
                1,
                "token zzqx{i:03} should find exactly its file, got {}",
                r.hits.len()
            );
            assert_eq!(r.hits[0].path, format!("note-{i:03}.md"));
        }
    }

    #[tokio::test]
    async fn scan_reconciles_orphan_search_docs() {
        use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("live.md"), "alpha live note\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        // Simulate a doc left behind for a file that no longer exists
        // (e.g. renamed/deleted while the app wasn't watching).
        cubical_core_index_doc(&vault, "ghost.md", "alpha ghost note").await;
        vault.search().commit().unwrap();
        let q = SearchQuery {
            text: "alpha".into(),
            limit: 0,
            offset: 0,
            fields: FieldScope::Default,
            fuzzy: false,
            sort: SortMode::Relevance,
        };
        let before = run_search(vault.search(), &q).unwrap().hits;
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].path, "ghost.md", "orphan present pre-scan");

        // A scan walks only `live.md`; it indexes live.md and reconcile
        // must drop the orphan `ghost.md`.
        let (tx, _rx) = mpsc::channel::<ScanProgress>(8);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        let after = run_search(vault.search(), &q).unwrap().hits;
        assert_eq!(after.len(), 1, "ghost doc reconciled away, live indexed");
        assert_eq!(after[0].path, "live.md");
    }

    #[tokio::test]
    async fn scan_sweeps_files_rows_for_paths_deleted_while_app_closed() {
        // A file deleted on disk while the app was closed fires no watcher
        // event, so its `files` row would linger in `list_files` (and the
        // tree) forever. The post-walk sweep must drop any row not seen by
        // this scan (its `last_seen` predates the scan). Regression guard
        // for the "deleted file lingers in the file tree" bug.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("live.md"), "still here\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        // Seed a stale row for a path that does NOT exist on disk, with an
        // ancient `last_seen` (a prior scan that saw it; the file has
        // since been deleted externally).
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                 ) VALUES ('ghost.md', 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                (),
            )
            .await
            .unwrap();

        let (tx, _rx) = mpsc::channel::<ScanProgress>(8);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        let conn = vault.index().connection();
        let count = |sql: &'static str| {
            let conn = conn.clone();
            async move {
                let mut rows = conn.query(sql, ()).await.unwrap();
                rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
            }
        };
        assert_eq!(
            count("SELECT COUNT(*) FROM files WHERE path='ghost.md'").await,
            0,
            "stale row for a deleted file must be swept",
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM files WHERE path='live.md'").await,
            1,
            "the on-disk file must survive the sweep",
        );
    }

    #[tokio::test]
    async fn scan_records_directories_and_sweeps_deleted_ones() {
        // Empty folders aren't representable in the files-derived tree, so
        // the scan records every directory into `folders` (and sweeps rows
        // for dirs deleted while the app wasn't watching).
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("projects/2026")).unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::write(dir.path().join("projects/note.md"), "hi\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        // Seed a stale folder row for a dir that no longer exists on disk.
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO folders (path, created_at, last_seen) VALUES ('ghost', 0, 0)",
                (),
            )
            .await
            .unwrap();

        let (tx, _rx) = mpsc::channel::<ScanProgress>(8);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        let got = cubical_index::list_folders(vault.index()).await.unwrap();
        assert_eq!(
            got,
            vec!["empty", "projects", "projects/2026"],
            "every on-disk dir recorded (incl. the empty one); ghost swept",
        );
    }

    /// Index a doc directly into the search index (test helper for
    /// simulating orphans).
    async fn cubical_core_index_doc(vault: &Vault, path: &str, body: &str) {
        super::super::search_refresh::refresh_search_index(vault, path, body, 0, body.len() as u64)
            .await
            .unwrap();
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

    #[tokio::test]
    async fn scan_populates_tags_table_from_inline_and_frontmatter() {
        use cubical_index::{tags_for_file, TagSource};
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("a.md"),
            "---\ntags: [project/cubical, todo]\n---\n\nbody with #review tag\n",
        )
        .unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        let rows = tags_for_file(vault.index(), "a.md").await.expect("query");
        // 1 inline + 2 frontmatter = 3 rows.
        assert_eq!(rows.len(), 3);
        assert!(rows
            .iter()
            .any(|r| r.tag_path == "review" && r.source == TagSource::Inline));
        assert!(rows
            .iter()
            .any(|r| r.tag_path == "project/cubical" && r.source == TagSource::Frontmatter));
        assert!(rows
            .iter()
            .any(|r| r.tag_path == "todo" && r.source == TagSource::Frontmatter));
    }

    #[tokio::test]
    async fn scan_resolves_forward_references() {
        use cubical_index::links_from;
        let dir = tempdir().unwrap();
        // Two files linking to EACH OTHER. WalkDir yields entries in
        // unspecified order (APFS hash order, not alphabetical), so we
        // can't assume which is visited first — but whichever it is, its
        // link to the other is a forward reference (the target's `files`
        // row doesn't exist yet under per-file resolution → NULL). The
        // post-walk resolution pass sees the COMPLETE file set, so BOTH
        // links must resolve on the first scan regardless of walk order.
        // See docs/layer-3-spec.md §5.6.
        fs::write(dir.path().join("aaa.md"), "ref to [[zzz]]\n").unwrap();
        fs::write(dir.path().join("zzz.md"), "ref to [[aaa]]\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();
        scan(vault.clone(), cancel, tx).await.expect("scan");

        let from_aaa = links_from(vault.index(), "aaa.md").await.expect("query");
        assert_eq!(from_aaa.len(), 1);
        assert_eq!(from_aaa[0].target_path.as_deref(), Some("zzz.md"));

        let from_zzz = links_from(vault.index(), "zzz.md").await.expect("query");
        assert_eq!(from_zzz.len(), 1);
        assert_eq!(from_zzz[0].target_path.as_deref(), Some("aaa.md"));
    }

    #[tokio::test]
    async fn scan_materializes_pending_rewrites_before_extracting_links() {
        // L3 Session J (chain 3): pass-1 reads each markdown file and
        // materializes any pending wiki-link rewrites before handing
        // the source to the link extractor. So backlinks reflect the
        // post-rewrite world even before the pending queue flushes.
        use cubical_index::{enqueue_pending, links_from, NewPendingRewrite, RewriteKind};
        let dir = tempdir().unwrap();
        // On disk: a.md links to OldName via wiki-link.
        fs::write(dir.path().join("a.md"), "linked to [[OldName]]\n").unwrap();
        // Real target file Daily.md exists so the rewrite resolves.
        fs::write(dir.path().join("Daily.md"), "body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

        // Enqueue a pending wiki-link rewrite for a.md: OldName → Daily.
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "a.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "OldName".into(),
                new_token: "Daily".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");

        let rows = links_from(vault.index(), "a.md").await.expect("query");
        // The scanned link points at the post-rewrite target — Daily.md —
        // not OldName.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_raw, "Daily");
        assert_eq!(rows[0].target_path.as_deref(), Some("Daily.md"));

        // On-disk bytes untouched (materialize-on-read doesn't write).
        let on_disk = std::fs::read_to_string(dir.path().join("a.md")).unwrap();
        assert_eq!(on_disk, "linked to [[OldName]]\n");
    }

    #[tokio::test]
    async fn scan_populates_links_table_and_resolves_targets() {
        use cubical_index::links_from;
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("a.md"),
            "see [[b]] for more and [[c]] too\n",
        )
        .unwrap();
        fs::write(dir.path().join("b.md"), "body\n").unwrap();
        // c.md intentionally missing so we can prove the unresolved row
        // still lands with target_path = NULL.
        let vault = Vault::open(dir.path()).await.expect("open");

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();
        scan(vault.clone(), cancel, tx).await.expect("scan");

        let rows = links_from(vault.index(), "a.md").await.expect("query");
        assert_eq!(rows.len(), 2);
        // Resolved match for b.md.
        let to_b = rows.iter().find(|r| r.target_raw == "b").expect("b row");
        assert_eq!(to_b.target_path.as_deref(), Some("b.md"));
        // Unresolved row for missing c — kept with NULL target_path so a
        // future scan / rename can re-resolve it.
        let to_c = rows.iter().find(|r| r.target_raw == "c").expect("c row");
        assert!(to_c.target_path.is_none());
    }

    #[tokio::test]
    async fn scan_populates_search_index() {
        // L4-A: scan Pass 1 fans out into the Tantivy index alongside
        // frontmatter/links/tags/blocks. After scan completes the final
        // commit makes the docs queryable.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "# A\n\nalpha body\n").unwrap();
        fs::write(dir.path().join("b.md"), "# B\n\nbeta body\n").unwrap();

        let vault = Vault::open(dir.path()).await.expect("open");
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(8);
        let cancel = CancellationToken::new();
        scan(vault.clone(), cancel, tx).await.expect("scan");
        while rx.recv().await.is_some() {}

        assert_eq!(vault.search().doc_count().unwrap(), 2);
    }
}
