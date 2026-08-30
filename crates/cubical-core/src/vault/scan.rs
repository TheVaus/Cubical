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
    frontmatter::refresh_frontmatter_with_doc,
    links::{
        extract_links, keeps_link_row, read_source_off_executor, LinkExtraction, PathResolver,
    },
    parse::parse_off_executor,
    pending::materialize_on_read,
    search_refresh::refresh_search_index_with_doc,
    tags::refresh_tags_with_doc,
    Vault, VaultError,
};

const SCAN_BATCH_SIZE: u32 = 500;

const SEARCH_COMMIT_EVERY: usize = 5_000;

#[derive(Debug, Clone, Copy)]
pub struct ScanProgress {
    pub files_processed: u32,
    pub files_total_estimate: u32,
}

#[derive(Debug, Clone)]
pub struct VanishedFile {
    pub path: String,
    pub inode: Option<i64>,
    pub content_hash: String,
}

#[derive(Debug, Clone)]
pub struct ScanOutcome {
    pub file_count: u32,
    pub vanished: Vec<VanishedFile>,
}

async fn collect_vanished(conn: &libsql::Connection, scan_started_secs: i64) -> Vec<VanishedFile> {
    let mut rows = match conn
        .query(
            "SELECT path, inode, content_hash FROM files WHERE last_seen < ?1",
            params![scan_started_secs],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "scan: could not read the rows it is about to sweep");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    while let Ok(Some(row)) = rows.next().await {
        let Ok(path) = row.get::<String>(0) else {
            continue;
        };
        out.push(VanishedFile {
            path,
            inode: row.get::<Option<i64>>(1).unwrap_or(None),
            content_hash: row.get::<String>(2).unwrap_or_default(),
        });
    }
    out
}

pub async fn scan(
    vault: Vault,
    cancel: CancellationToken,
    progress: mpsc::Sender<ScanProgress>,
) -> Result<ScanOutcome, VaultError> {
    let root = vault.root().to_path_buf();
    let registry = vault.registry_arc();

    let scan_started_secs = unix_now_secs();

    let mut files_processed: u32 = 0;
    let mut files_total_estimate: u32 = 0;

    let conn = vault.index().connection();
    let mut tx = conn.transaction().await.map_err(IndexError::from)?;
    let mut batch_count: u32 = 0;
    let mut search_batch_count: usize = 0;
    let mut indexed_search_paths: std::collections::HashSet<String> =
        std::collections::HashSet::new();

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
        !name.starts_with('.')
    });

    for entry_result in walker {
        if cancel.is_cancelled() {
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
            if entry.file_type().is_dir() && entry.depth() > 0 {
                let rel = crate::vault::relpath::to_vault_relative(
                    entry.path().strip_prefix(&root).unwrap_or(entry.path()),
                );
                if let Err(e) = upsert_folder(vault.index(), &rel, scan_started_secs).await {
                    tracing::warn!(path = %rel, error = %e, "folder upsert failed; skipping");
                }
            }
            continue;
        }
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

        let path_str = crate::vault::relpath::to_vault_relative(&rel_path);
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

            if let Some(doc) = parse_off_executor(&source).await {
                if let Err(e) = refresh_frontmatter_with_doc(&vault, &path_str, &doc).await {
                    tracing::warn!(path = %abs_path.display(), error = %e, "frontmatter refresh failed");
                }
                let extractions = extract_links(&doc);
                if !extractions.is_empty() {
                    pending_links.push((path_str.clone(), extractions));
                }
                if let Err(e) = refresh_tags_with_doc(&vault, &path_str, &doc).await {
                    tracing::warn!(path = %abs_path.display(), error = %e, "tags refresh failed");
                }
                if let Err(e) = refresh_blocks(&vault, &path_str, &source).await {
                    tracing::warn!(path = %abs_path.display(), error = %e, "blocks refresh failed");
                }
                if !cancel.is_cancelled() {
                    let search_size_bytes = source.len() as u64;
                    if let Err(e) = refresh_search_index_with_doc(
                        &vault,
                        &path_str,
                        &doc,
                        mtime_unix,
                        search_size_bytes,
                    )
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
            } else {
                tracing::warn!(path = %abs_path.display(), "markdown parse failed; derived tables left untouched");
            }
        }

        files_processed = files_processed.saturating_add(1);

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

    tx.commit().await.map_err(IndexError::from)?;

    if let Err(e) = vault.search().commit() {
        tracing::warn!(error = %e, "search index final commit failed");
    }

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

    let mut vanished: Vec<VanishedFile> = Vec::new();
    if !cancel.is_cancelled() {
        vanished = collect_vanished(conn, scan_started_secs).await;
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

        match sweep_stale_folders(vault.index(), scan_started_secs).await {
            Ok(n) if n > 0 => tracing::info!(removed = n, "scan swept rows for deleted folders"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "folders sweep failed"),
        }
    }

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
            .filter_map(|e| {
                let target_path = resolver.resolve(&e.target_raw);
                if !keeps_link_row(e.from_property_ref, &target_path) {
                    return None;
                }
                let (anchor_kind, anchor_value) = match e.anchor {
                    Some(Anchor::Heading { value }) => (Some("heading".to_string()), Some(value)),
                    Some(Anchor::Block { value }) => (Some("block".to_string()), Some(value)),
                    None => (None, None),
                };
                Some(LinkRow {
                    target_raw: e.target_raw,
                    target_path,
                    anchor_kind,
                    anchor_value,
                    display_text: e.display,
                    is_embed: e.is_embed,
                    position: e.position,
                })
            })
            .collect();
        if let Err(e) = replace_links_for_file(vault.index(), &source_path, &rows).await {
            tracing::warn!(path = %source_path, error = %e, "links resolve/write failed");
        }
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
    Ok(ScanOutcome {
        file_count: files_processed,
        vanished,
    })
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
pub fn inode_of(meta: &std::fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    Some(clamp_to_i64(meta.ino()))
}

#[cfg(not(unix))]
pub fn inode_of(_meta: &std::fs::Metadata) -> Option<i64> {
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
        assert_eq!(count.file_count as usize, n);
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
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("live.md"), "still here\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

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
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("projects/2026")).unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::write(dir.path().join("projects/note.md"), "hi\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

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

    async fn cubical_core_index_doc(vault: &Vault, path: &str, body: &str) {
        super::super::search_refresh::refresh_search_index(vault, path, body, 0, body.len() as u64)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn scan_inserts_a_row_per_file_without_modifying_content() {
        let (dir, vault) = fixture_vault(10, &[]).await;
        let mut before: Vec<(String, String)> = Vec::new();
        for i in 0..10 {
            let p = dir.path().join(format!("note-{i:03}.md"));
            let bytes = fs::read(&p).unwrap();
            before.push((format!("note-{i:03}.md"), sha256_hex(&bytes)));
        }

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();
        let count = scan(vault.clone(), cancel, tx).await.expect("scan");
        assert_eq!(count.file_count, 10);

        assert_eq!(scalar_i64(&vault, "SELECT COUNT(*) FROM files").await, 10);
        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM files WHERE type_id = 'markdown'"
            )
            .await,
            10,
        );

        for (rel, expected_hash) in before {
            let bytes = fs::read(dir.path().join(&rel)).unwrap();
            assert_eq!(sha256_hex(&bytes), expected_hash, "{rel} byte-changed");

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
        assert_eq!(count.file_count, 20);
        assert!(events >= 1, "expected at least one progress event");
        let last = last.unwrap();
        assert_eq!(last.files_processed, 20);
        assert_eq!(last.files_total_estimate, 20);
    }

    #[tokio::test]
    async fn scan_stops_early_when_cancelled_on_a_200_file_vault() {
        let (_dir, vault) = fixture_vault(200, &[]).await;
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();

        let scan_handle = tokio::spawn(scan(vault.clone(), cancel.clone(), tx));

        let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("first progress within 2s");

        cancel.cancel();
        tokio::spawn(async move { while rx.recv().await.is_some() {} });

        let result = tokio::time::timeout(Duration::from_secs(10), scan_handle)
            .await
            .expect("scan task did not settle after cancellation");
        let inner = result.expect("scan task panicked");
        match inner {
            Err(VaultError::ScanCancelled) => {}
            other => panic!("expected ScanCancelled, got {other:?}"),
        }

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

        tokio::time::sleep(Duration::from_millis(1100)).await;

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
        assert_eq!(
            scalar_i64(&vault, "SELECT COUNT(*) FROM frontmatter").await,
            3
        );
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

        assert_eq!(
            scalar_i64(
                &vault,
                "SELECT COUNT(*) FROM files WHERE path = 'broken.md'"
            )
            .await,
            1
        );
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
        use cubical_index::{enqueue_pending, links_from, NewPendingRewrite, RewriteKind};
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "linked to [[OldName]]\n").unwrap();
        fs::write(dir.path().join("Daily.md"), "body\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");

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
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_raw, "Daily");
        assert_eq!(rows[0].target_path.as_deref(), Some("Daily.md"));

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
        let vault = Vault::open(dir.path()).await.expect("open");

        let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
        let cancel = CancellationToken::new();
        scan(vault.clone(), cancel, tx).await.expect("scan");

        let rows = links_from(vault.index(), "a.md").await.expect("query");
        assert_eq!(rows.len(), 2);
        let to_b = rows.iter().find(|r| r.target_raw == "b").expect("b row");
        assert_eq!(to_b.target_path.as_deref(), Some("b.md"));
        let to_c = rows.iter().find(|r| r.target_raw == "c").expect("c row");
        assert!(to_c.target_path.is_none());
    }

    #[tokio::test]
    async fn scan_populates_search_index() {
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
