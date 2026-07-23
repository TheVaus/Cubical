use std::path::Path;

use serde::{Deserialize, Serialize};

pub const CAP: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentVaultEntry {
    pub path: String,
    pub last_opened_unix: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentVault {
    pub path: String,
    pub last_opened_unix: i64,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListRecentVaultsResponse {
    pub vaults: Vec<RecentVault>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveRecentVaultRequest {
    pub path: String,
}

pub fn load(store: &Path) -> Vec<RecentVaultEntry> {
    match std::fs::read(store) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn record(store: &Path, vault_path: &str, now_unix: i64) {
    let mut entries = load(store);
    entries.retain(|e| e.path != vault_path);
    entries.insert(
        0,
        RecentVaultEntry {
            path: vault_path.to_string(),
            last_opened_unix: now_unix,
        },
    );
    entries.truncate(CAP);
    let _ = atomic_write(store, &entries);
}

pub fn remove(store: &Path, vault_path: &str) {
    let mut entries = load(store);
    let before = entries.len();
    entries.retain(|e| e.path != vault_path);
    if entries.len() != before {
        let _ = atomic_write(store, &entries);
    }
}

pub fn list_with_existence(store: &Path) -> Vec<RecentVault> {
    load(store)
        .into_iter()
        .map(|e| {
            let exists = Path::new(&e.path).is_dir();
            RecentVault {
                path: e.path,
                last_opened_unix: e.last_opened_unix,
                exists,
            }
        })
        .collect()
}

fn atomic_write(store: &Path, entries: &[RecentVaultEntry]) -> std::io::Result<()> {
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(entries)?;
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, store)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store_path(dir: &std::path::Path) -> std::path::PathBuf {
        dir.join("recent_vaults.json")
    }

    #[test]
    fn load_missing_file_is_empty() {
        let dir = tempdir().unwrap();
        assert!(load(&store_path(dir.path())).is_empty());
    }

    #[test]
    fn load_corrupt_file_is_empty() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(load(&p).is_empty());
    }

    #[test]
    fn record_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        record(&p, "/vaults/a", 100);
        let got = load(&p);
        assert_eq!(
            got,
            vec![RecentVaultEntry {
                path: "/vaults/a".into(),
                last_opened_unix: 100
            }]
        );
    }

    #[test]
    fn record_dedupes_and_moves_to_top_with_new_timestamp() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        record(&p, "/vaults/a", 100);
        record(&p, "/vaults/b", 200);
        record(&p, "/vaults/a", 300);
        let got = load(&p);
        assert_eq!(
            got.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["/vaults/a", "/vaults/b"]
        );
        assert_eq!(got[0].last_opened_unix, 300);
    }

    #[test]
    fn record_caps_at_ten_and_evicts_oldest() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        for i in 0..12 {
            record(&p, &format!("/vaults/v{i}"), i as i64);
        }
        let got = load(&p);
        assert_eq!(got.len(), CAP);
        assert_eq!(got.first().unwrap().path, "/vaults/v11");
        assert_eq!(got.last().unwrap().path, "/vaults/v2");
    }

    #[test]
    fn remove_drops_matching_entry() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        record(&p, "/vaults/a", 100);
        record(&p, "/vaults/b", 200);
        remove(&p, "/vaults/a");
        assert_eq!(
            load(&p).iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["/vaults/b"]
        );
    }

    #[test]
    fn list_stamps_existence_and_does_not_mutate() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        let real = dir.path().to_string_lossy().to_string();
        record(&p, &real, 100);
        record(&p, "/definitely/missing/vault", 200);
        let listed = list_with_existence(&p);
        assert_eq!(listed[0].path, "/definitely/missing/vault");
        assert!(!listed[0].exists);
        assert_eq!(listed[1].path, real);
        assert!(listed[1].exists);
        assert_eq!(load(&p).len(), 2);
    }
}
