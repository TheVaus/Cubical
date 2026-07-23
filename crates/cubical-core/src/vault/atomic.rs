use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::vault::VaultError;

const TMP_SUFFIX: &str = ".cubical-tmp";

const RENAME_RETRY_DELAYS: &[Duration] = &[
    Duration::from_millis(50),
    Duration::from_millis(200),
    Duration::from_millis(800),
];

pub fn atomic_write(target: &Path, content: &[u8]) -> Result<(), VaultError> {
    let tmp = temp_path_for(target);

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(VaultError::Io)?;
        file.write_all(content).map_err(VaultError::Io)?;
        file.sync_all().map_err(VaultError::Io)?;
        drop(file);
    }

    rename_with_retry(&tmp, target)
}

fn temp_path_for(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_owned();
    s.push(TMP_SUFFIX);
    PathBuf::from(s)
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), VaultError> {
    let mut last_err: Option<std::io::Error> = None;
    let attempts = std::iter::once(Duration::ZERO).chain(RENAME_RETRY_DELAYS.iter().copied());
    for delay in attempts {
        if delay > Duration::ZERO {
            std::thread::sleep(delay);
        }
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if is_transient_rename_error(&e) => {
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(VaultError::Io(e)),
        }
    }
    Err(VaultError::Io(last_err.unwrap_or_else(|| {
        std::io::Error::other("rename failed without OS error")
    })))
}

#[cfg(windows)]
fn is_transient_rename_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

#[cfg(not(windows))]
fn is_transient_rename_error(_e: &std::io::Error) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn writes_content_to_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");

        atomic_write(&target, b"hello world\n").unwrap();

        let got = fs::read(&target).unwrap();
        assert_eq!(got, b"hello world\n");
    }

    #[test]
    fn leaves_no_tmp_file_on_success() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");

        atomic_write(&target, b"x").unwrap();

        let tmp = temp_path_for(&target);
        assert!(!tmp.exists(), "tmp file should be gone after rename");
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, b"original\n").unwrap();

        atomic_write(&target, b"replaced\n").unwrap();

        let got = fs::read(&target).unwrap();
        assert_eq!(got, b"replaced\n");
    }

    #[test]
    fn rejects_target_in_missing_directory() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("nope").join("note.md");

        let err = atomic_write(&target, b"x").unwrap_err();
        assert!(matches!(err, VaultError::Io(_)), "got {err:?}");
    }

    #[test]
    fn handles_empty_content() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("empty.md");

        atomic_write(&target, b"").unwrap();

        let got = fs::read(&target).unwrap();
        assert_eq!(got, b"");
    }

    #[test]
    fn temp_path_for_appends_suffix() {
        assert_eq!(
            temp_path_for(Path::new("/v/note.md")),
            PathBuf::from("/v/note.md.cubical-tmp"),
        );
    }
}
