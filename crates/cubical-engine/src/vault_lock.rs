use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub struct VaultLockGuard {
    file: File,
    lock_path: PathBuf,
    owner_path: PathBuf,
}

impl VaultLockGuard {
    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }
}

impl Drop for VaultLockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.owner_path);
        let _ = self.file.unlock();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockOwner {
    pub pid: u32,
    pub socket_path: Option<String>,
}

pub enum Acquire {
    Acquired(VaultLockGuard),
    Held(LockOwner),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct LockPayload {
    pid: u32,
    path: String,
    #[serde(default)]
    socket_path: Option<String>,
}

pub fn acquire(canonical_vault_path: &Path, socket_path: Option<&str>) -> io::Result<Acquire> {
    acquire_in(&runtime_dir(), canonical_vault_path, socket_path)
}

pub(crate) fn acquire_in(
    dir: &Path,
    canonical_vault_path: &Path,
    socket_path: Option<&str>,
) -> io::Result<Acquire> {
    std::fs::create_dir_all(dir)?;
    let lock_path = dir.join(lock_filename(canonical_vault_path));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)?;

    let owner_path = lock_path.with_extension("owner");

    match file.try_lock() {
        Ok(()) => {
            write_payload(&owner_path, canonical_vault_path, socket_path)?;
            Ok(Acquire::Acquired(VaultLockGuard {
                file,
                lock_path,
                owner_path,
            }))
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let owner = read_owner(&owner_path).unwrap_or(LockOwner {
                pid: 0,
                socket_path: None,
            });
            Ok(Acquire::Held(owner))
        }
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

fn write_payload(
    owner_path: &Path,
    canonical_vault_path: &Path,
    socket_path: Option<&str>,
) -> io::Result<()> {
    let payload = LockPayload {
        pid: std::process::id(),
        path: canonical_vault_path.to_string_lossy().into_owned(),
        socket_path: socket_path.map(|s| s.to_string()),
    };
    let bytes = serde_json::to_vec(&payload).map_err(io::Error::other)?;
    std::fs::write(owner_path, &bytes)
}

fn read_owner(owner_path: &Path) -> Option<LockOwner> {
    let bytes = std::fs::read(owner_path).ok()?;
    let payload: LockPayload = serde_json::from_slice(&bytes).ok()?;
    Some(LockOwner {
        pid: payload.pid,
        socket_path: payload.socket_path,
    })
}

fn lock_filename(canonical_vault_path: &Path) -> String {
    use sha2::{Digest, Sha256};

    use std::fmt::Write as _;

    let mut hasher = Sha256::new();
    hasher.update(canonical_vault_path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut name = String::with_capacity(digest.len() * 2 + 5);
    for byte in digest {
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(".lock");
    name
}

pub fn runtime_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CUBICAL_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    dirs::runtime_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("cubical")
        .join("locks")
}

#[cfg(test)]
pub(crate) static RUNTIME_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_on_a_free_path_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Path::new("/vaults/alpha");
        match acquire_in(dir.path(), vault, None).unwrap() {
            Acquire::Acquired(_) => {}
            Acquire::Held(_) => panic!("free path should be acquirable"),
        }
    }

    #[test]
    fn a_second_acquire_reports_the_current_owner() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Path::new("/vaults/beta");
        let _held = match acquire_in(dir.path(), vault, None).unwrap() {
            Acquire::Acquired(g) => g,
            Acquire::Held(_) => panic!("first acquire should succeed"),
        };
        match acquire_in(dir.path(), vault, None).unwrap() {
            Acquire::Acquired(_) => panic!("second acquire must not succeed while held"),
            Acquire::Held(owner) => assert_eq!(owner.pid, std::process::id()),
        }
    }

    #[test]
    fn releasing_the_guard_allows_reacquire() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Path::new("/vaults/gamma");
        {
            let g = match acquire_in(dir.path(), vault, None).unwrap() {
                Acquire::Acquired(g) => g,
                Acquire::Held(_) => panic!("first acquire should succeed"),
            };
            drop(g);
        }
        match acquire_in(dir.path(), vault, None).unwrap() {
            Acquire::Acquired(_) => {}
            Acquire::Held(_) => panic!("after release the path should be free again"),
        }
    }

    #[test]
    fn distinct_vault_paths_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let _a = match acquire_in(dir.path(), Path::new("/vaults/one"), None).unwrap() {
            Acquire::Acquired(g) => g,
            Acquire::Held(_) => panic!("first vault should be acquirable"),
        };
        match acquire_in(dir.path(), Path::new("/vaults/two"), None).unwrap() {
            Acquire::Acquired(_) => {}
            Acquire::Held(_) => panic!("a different vault path must lock independently"),
        }
    }

    #[test]
    fn the_lock_file_lands_in_the_given_dir() {
        let dir = tempfile::tempdir().unwrap();
        let g = match acquire_in(dir.path(), Path::new("/vaults/delta"), None).unwrap() {
            Acquire::Acquired(g) => g,
            Acquire::Held(_) => panic!("acquire should succeed"),
        };
        assert!(g.lock_path().starts_with(dir.path()));
        assert!(g.lock_path().exists());
    }

    #[test]
    fn acquire_advertises_the_socket_path() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Path::new("/vaults/epsilon");
        let _held = match acquire_in(dir.path(), vault, Some("/run/cubical-1.sock")).unwrap() {
            Acquire::Acquired(g) => g,
            Acquire::Held(_) => panic!("first acquire should succeed"),
        };
        match acquire_in(dir.path(), vault, None).unwrap() {
            Acquire::Acquired(_) => panic!("still held"),
            Acquire::Held(owner) => {
                assert_eq!(owner.socket_path.as_deref(), Some("/run/cubical-1.sock"));
            }
        }
    }

    #[test]
    fn runtime_dir_honors_the_env_override() {
        let _guard = RUNTIME_ENV_GUARD.lock().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", "/tmp/cubical-test-runtime");
        assert_eq!(runtime_dir(), PathBuf::from("/tmp/cubical-test-runtime"));
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }
}
