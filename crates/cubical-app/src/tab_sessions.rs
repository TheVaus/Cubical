use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabRecord {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub tag_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabSession {
    pub tabs: Vec<TabRecord>,
    pub active_id: Option<String>,
}

type Store = BTreeMap<String, TabSession>;

fn read_all(store: &Path) -> Store {
    match std::fs::read(store) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

pub fn load(store: &Path, vault_path: &str) -> TabSession {
    read_all(store).remove(vault_path).unwrap_or_default()
}

pub fn save(store: &Path, vault_path: &str, session: &TabSession) {
    let mut all = read_all(store);
    if session.tabs.is_empty() {
        all.remove(vault_path);
    } else {
        all.insert(vault_path.to_string(), session.clone());
    }
    let _ = atomic_write(store, &all);
}

fn atomic_write(store: &Path, all: &Store) -> std::io::Result<()> {
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(all)?;
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_path(dir: &Path) -> std::path::PathBuf {
        dir.join("tab_sessions.json")
    }

    fn file_tab(path: &str) -> TabRecord {
        TabRecord {
            id: format!("file:{path}"),
            kind: "file".into(),
            path: Some(path.into()),
            tag_path: None,
        }
    }

    #[test]
    fn missing_store_loads_an_empty_session() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load(&store_path(dir.path()), "/vaults/a"),
            TabSession::default()
        );
    }

    #[test]
    fn saved_session_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_path(dir.path());
        let session = TabSession {
            tabs: vec![file_tab("a.md"), file_tab("b.md")],
            active_id: Some("file:b.md".into()),
        };
        save(&store, "/vaults/a", &session);
        assert_eq!(load(&store, "/vaults/a"), session);
    }

    #[test]
    fn sessions_are_keyed_per_vault() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_path(dir.path());
        let a = TabSession {
            tabs: vec![file_tab("a.md")],
            active_id: Some("file:a.md".into()),
        };
        let b = TabSession {
            tabs: vec![file_tab("b.md")],
            active_id: Some("file:b.md".into()),
        };
        save(&store, "/vaults/a", &a);
        save(&store, "/vaults/b", &b);
        assert_eq!(load(&store, "/vaults/a"), a);
        assert_eq!(load(&store, "/vaults/b"), b);
    }

    #[test]
    fn saving_an_empty_session_forgets_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_path(dir.path());
        save(
            &store,
            "/vaults/a",
            &TabSession {
                tabs: vec![file_tab("a.md")],
                active_id: Some("file:a.md".into()),
            },
        );
        save(&store, "/vaults/a", &TabSession::default());
        assert_eq!(load(&store, "/vaults/a"), TabSession::default());
    }

    #[test]
    fn a_corrupt_store_loads_as_empty_instead_of_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_path(dir.path());
        std::fs::write(&store, b"{ not json").unwrap();
        assert_eq!(load(&store, "/vaults/a"), TabSession::default());
    }
}
