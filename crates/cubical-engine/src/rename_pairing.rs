use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cubical_core::Vault;
use libsql::params;
use tokio::sync::Mutex;

pub(crate) const TOMBSTONE_TTL: Duration = Duration::from_secs(2);

pub(crate) const TOMBSTONE_CAPACITY: usize = 256;

#[derive(Clone, Debug)]
pub(crate) struct Tombstone {
    pub path: String,
    pub type_id: String,
    pub size_bytes: i64,
    pub mtime_unix: i64,
    pub content_hash: String,
    pub inode: Option<i64>,
    pub created_at: i64,
    pub at: Instant,
}

pub(crate) type Tombstones = Arc<Mutex<VecDeque<Tombstone>>>;

#[must_use]
pub(crate) fn new_tombstones() -> Tombstones {
    Arc::new(Mutex::new(VecDeque::new()))
}

#[derive(Clone, Debug)]
pub(crate) enum RenameSource {
    Tracked(String),
    Tombstoned(Box<Tombstone>),
}

impl RenameSource {
    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Tracked(path) => path,
            Self::Tombstoned(t) => &t.path,
        }
    }
}

pub(crate) async fn path_is_tracked(vault: &Vault, path: &str) -> bool {
    let conn = vault.index().connection();
    match conn
        .query("SELECT 1 FROM files WHERE path = ?1", params![path])
        .await
    {
        Ok(mut rows) => matches!(rows.next().await, Ok(Some(_))),
        Err(e) => {
            tracing::warn!(path = %path, error = %e, "rename pairing: tracked lookup failed");
            false
        }
    }
}

pub(crate) async fn capture_tombstone(vault: &Vault, tombstones: &Tombstones, path: &str) {
    let conn = vault.index().connection();
    let row = conn
        .query(
            "SELECT type_id, size_bytes, mtime_unix, content_hash, inode, created_at
             FROM files WHERE path = ?1",
            params![path],
        )
        .await;
    let mut rows = match row {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(path = %path, error = %e, "rename pairing: tombstone read failed");
            return;
        }
    };
    let Ok(Some(row)) = rows.next().await else {
        return;
    };
    let tombstone = Tombstone {
        path: path.to_string(),
        type_id: row.get::<String>(0).unwrap_or_else(|_| "binary".into()),
        size_bytes: row.get::<i64>(1).unwrap_or_default(),
        mtime_unix: row.get::<i64>(2).unwrap_or_default(),
        content_hash: row.get::<String>(3).unwrap_or_default(),
        inode: row.get::<Option<i64>>(4).unwrap_or_default(),
        created_at: row.get::<i64>(5).unwrap_or_default(),
        at: Instant::now(),
    };

    let mut buffer = tombstones.lock().await;
    prune_expired(&mut buffer);
    buffer.retain(|t| t.path != tombstone.path);
    while buffer.len() >= TOMBSTONE_CAPACITY {
        buffer.pop_front();
    }
    buffer.push_back(tombstone);
}

pub(crate) async fn forget_tombstone(tombstones: &Tombstones, path: &str) {
    let mut buffer = tombstones.lock().await;
    buffer.retain(|t| t.path != path);
}

pub(crate) async fn live_tombstones(tombstones: &Tombstones) -> Vec<Tombstone> {
    let mut buffer = tombstones.lock().await;
    prune_expired(&mut buffer);
    buffer.iter().cloned().collect()
}

fn prune_expired(buffer: &mut VecDeque<Tombstone>) {
    let now = Instant::now();
    buffer.retain(|t| now.duration_since(t.at) < TOMBSTONE_TTL);
}

pub(crate) async fn find_rename_source(
    vault: &Vault,
    tombstones: &Tombstones,
    to_path: &str,
    inode: Option<i64>,
    content_hash: &str,
) -> Option<RenameSource> {
    let live = live_tombstones(tombstones).await;

    if let Some(inode) = inode {
        let mut pool = candidate_pool(
            tracked_by_inode(vault, inode, to_path).await,
            live.iter()
                .filter(|t| t.inode == Some(inode) && t.path != to_path)
                .cloned()
                .collect(),
        );
        pool.retain(|_, source| !exists_on_disk(vault, source.path()));
        if pool.len() == 1 {
            return pool.into_values().next();
        }
        if !pool.is_empty() {
            tracing::debug!(
                to = %to_path,
                candidates = pool.len(),
                "rename pairing: ambiguous inode match; not adopting",
            );
            return None;
        }
    }

    if content_hash.is_empty() {
        return None;
    }
    let tombstoned: Vec<Tombstone> = live
        .into_iter()
        .filter(|t| t.content_hash == content_hash && t.path != to_path)
        .collect();
    if tombstoned.is_empty() {
        return None;
    }

    let pool = candidate_pool(
        tracked_by_hash(vault, content_hash, to_path).await,
        tombstoned,
    );
    if pool.len() != 1 {
        if pool.len() > 1 {
            tracing::debug!(
                to = %to_path,
                candidates = pool.len(),
                "rename pairing: content hash shared by several tracked files; not adopting",
            );
        }
        return None;
    }
    let source = pool.into_values().next()?;
    if exists_on_disk(vault, source.path()) {
        return None;
    }
    Some(source)
}

fn candidate_pool(
    tracked: Vec<String>,
    tombstoned: Vec<Tombstone>,
) -> BTreeMap<String, RenameSource> {
    let mut pool: BTreeMap<String, RenameSource> = BTreeMap::new();
    for path in tracked {
        pool.insert(path.clone(), RenameSource::Tracked(path));
    }
    for tombstone in tombstoned {
        pool.entry(tombstone.path.clone())
            .or_insert_with(|| RenameSource::Tombstoned(Box::new(tombstone)));
    }
    pool
}

fn exists_on_disk(vault: &Vault, rel: &str) -> bool {
    vault.root().join(rel).exists()
}

async fn tracked_by_inode(vault: &Vault, inode: i64, to_path: &str) -> Vec<String> {
    query_paths(
        vault,
        "SELECT path FROM files WHERE inode = ?1 AND path <> ?2",
        params![inode, to_path],
        "inode",
    )
    .await
}

async fn tracked_by_hash(vault: &Vault, content_hash: &str, to_path: &str) -> Vec<String> {
    query_paths(
        vault,
        "SELECT path FROM files WHERE content_hash = ?1 AND path <> ?2",
        params![content_hash, to_path],
        "content hash",
    )
    .await
}

async fn query_paths(
    vault: &Vault,
    sql: &str,
    args: impl libsql::params::IntoParams,
    what: &str,
) -> Vec<String> {
    let conn = vault.index().connection();
    let mut out = Vec::new();
    let mut rows = match conn.query(sql, args).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, lookup = %what, "rename pairing: candidate lookup failed");
            return out;
        }
    };
    while let Ok(Some(row)) = rows.next().await {
        if let Ok(path) = row.get::<String>(0) {
            out.push(path);
        }
    }
    out
}

pub(crate) async fn restore_row(vault: &Vault, tombstone: &Tombstone, now: i64) -> bool {
    let conn = vault.index().connection();
    let sql = "
        INSERT OR IGNORE INTO files (
            path, type_id, size_bytes, mtime_unix, content_hash,
            inode, last_seen, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7)
    ";
    match conn
        .execute(
            sql,
            params![
                tombstone.path.clone(),
                tombstone.type_id.clone(),
                tombstone.size_bytes,
                tombstone.mtime_unix,
                tombstone.content_hash.clone(),
                tombstone.inode,
                now,
                tombstone.created_at
            ],
        )
        .await
    {
        Ok(changed) => changed > 0,
        Err(e) => {
            tracing::warn!(
                path = %tombstone.path,
                error = %e,
                "rename pairing: could not restore the removed file row",
            );
            false
        }
    }
}

pub(crate) async fn drop_row(vault: &Vault, path: &str) {
    let conn = vault.index().connection();
    if let Err(e) = conn
        .execute("DELETE FROM files WHERE path = ?1", params![path])
        .await
    {
        tracing::warn!(
            path = %path,
            error = %e,
            "rename pairing: could not roll back the restored file row",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, body) in files {
            std::fs::write(dir.path().join(rel), body).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("vault open");
        (dir, vault)
    }

    async fn seed_row(vault: &Vault, path: &str, hash: &str, inode: Option<i64>) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES (?1, 'markdown', 0, 0, ?2, ?3, 0, 0, 0)",
                params![path, hash, inode],
            )
            .await
            .expect("seed row");
    }

    #[tokio::test]
    async fn a_tombstone_expires_after_the_ttl() {
        let mut buffer = VecDeque::new();
        buffer.push_back(Tombstone {
            path: "old.md".into(),
            type_id: "markdown".into(),
            size_bytes: 0,
            mtime_unix: 0,
            content_hash: "h".into(),
            inode: Some(1),
            created_at: 0,
            at: Instant::now() - TOMBSTONE_TTL - Duration::from_millis(1),
        });
        prune_expired(&mut buffer);
        assert!(buffer.is_empty(), "an expired tombstone is dropped");
    }

    #[tokio::test]
    async fn the_tombstone_buffer_is_capacity_bounded() {
        let (_dir, vault) = vault_with(&[]).await;
        let tombstones = new_tombstones();
        for i in 0..(TOMBSTONE_CAPACITY + 40) {
            let path = format!("f{i}.md");
            seed_row(&vault, &path, "h", Some(i as i64)).await;
            capture_tombstone(&vault, &tombstones, &path).await;
        }
        assert_eq!(
            tombstones.lock().await.len(),
            TOMBSTONE_CAPACITY,
            "a vault-wide delete must not balloon the buffer",
        );
    }

    #[tokio::test]
    async fn an_inode_shared_by_two_missing_candidates_is_not_paired() {
        let (_dir, vault) = vault_with(&[("new.md", "body\n")]).await;
        seed_row(&vault, "gone-a.md", "ha", Some(77)).await;
        seed_row(&vault, "gone-b.md", "hb", Some(77)).await;
        let tombstones = new_tombstones();

        assert!(
            find_rename_source(&vault, &tombstones, "new.md", Some(77), "hc")
                .await
                .is_none(),
            "two missing files sharing an inode are ambiguous",
        );
    }

    async fn tombstone_for(vault: &Vault, tombstones: &Tombstones, path: &str) {
        capture_tombstone(vault, tombstones, path).await;
        vault
            .index()
            .connection()
            .execute("DELETE FROM files WHERE path = ?1", params![path])
            .await
            .expect("delete row");
    }

    #[tokio::test]
    async fn a_hash_shared_with_a_live_file_is_not_paired() {
        let (_dir, vault) = vault_with(&[("kept.md", "same\n"), ("new.md", "same\n")]).await;
        seed_row(&vault, "kept.md", "shared", None).await;
        seed_row(&vault, "gone.md", "shared", None).await;
        let tombstones = new_tombstones();
        tombstone_for(&vault, &tombstones, "gone.md").await;

        assert!(
            find_rename_source(&vault, &tombstones, "new.md", None, "shared")
                .await
                .is_none(),
            "a duplicate hash must never be paired, even when only one candidate is missing",
        );
    }

    #[tokio::test]
    async fn a_hash_with_no_live_tombstone_is_not_looked_up_at_all() {
        let (_dir, vault) = vault_with(&[("new.md", "same\n")]).await;
        seed_row(&vault, "gone.md", "unique", None).await;
        let tombstones = new_tombstones();

        assert!(
            find_rename_source(&vault, &tombstones, "new.md", None, "unique")
                .await
                .is_none(),
            "hash pairing exists for cross-volume moves, which always leave a tombstone",
        );
    }

    #[tokio::test]
    async fn a_unique_tombstoned_hash_is_paired() {
        let (_dir, vault) = vault_with(&[("new.md", "same\n")]).await;
        seed_row(&vault, "gone.md", "unique", None).await;
        let tombstones = new_tombstones();
        tombstone_for(&vault, &tombstones, "gone.md").await;

        let source = find_rename_source(&vault, &tombstones, "new.md", None, "unique")
            .await
            .expect("a single missing candidate pairs");
        assert_eq!(source.path(), "gone.md");
    }

    #[tokio::test]
    async fn a_candidate_still_present_on_disk_is_not_paired() {
        let (_dir, vault) = vault_with(&[("kept.md", "same\n"), ("new.md", "same\n")]).await;
        seed_row(&vault, "kept.md", "unique", Some(31)).await;
        let tombstones = new_tombstones();

        assert!(
            find_rename_source(&vault, &tombstones, "new.md", Some(31), "unique")
                .await
                .is_none(),
            "a file that is still on disk did not move",
        );
    }

    #[tokio::test]
    async fn a_restored_row_can_be_rolled_back() {
        let (_dir, vault) = vault_with(&[]).await;
        seed_row(&vault, "gone.md", "h", Some(9)).await;
        let tombstones = new_tombstones();
        capture_tombstone(&vault, &tombstones, "gone.md").await;
        vault
            .index()
            .connection()
            .execute("DELETE FROM files WHERE path = 'gone.md'", ())
            .await
            .unwrap();

        let tombstone = live_tombstones(&tombstones).await.remove(0);
        assert!(restore_row(&vault, &tombstone, 5).await);
        assert!(path_is_tracked(&vault, "gone.md").await);
        drop_row(&vault, "gone.md").await;
        assert!(!path_is_tracked(&vault, "gone.md").await);
    }
}
