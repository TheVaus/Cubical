//! Atomic file writes: temp-file + fsync + rename.
//!
//! Per `docs/layer-0-spec.md` §4. The helper exists from L0 onward so
//! L1+ consumers (notably `write_file_text` in L2) don't have to
//! reinvent the dance — and so the Windows retry logic for locked
//! targets (antivirus, OneDrive) lives in one place.
//!
//! Sync API on purpose: callers run it inside
//! `tokio::task::spawn_blocking`. Both writing and `rename` block,
//! and pretending otherwise just hides the cost.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::vault::VaultError;

/// Extension appended to form the temp path adjacent to `target`.
const TMP_SUFFIX: &str = ".cubical-tmp";

/// Windows retry backoffs for the final `rename`. Sequential — total
/// budget ~1s. Spec §4: "50ms, 200ms, 800ms".
const RENAME_RETRY_DELAYS: &[Duration] = &[
    Duration::from_millis(50),
    Duration::from_millis(200),
    Duration::from_millis(800),
];

/// Write `content` to `target` atomically.
///
/// Procedure: open `<target>.cubical-tmp`, write all bytes, fsync the
/// file handle, drop it, then `rename` over `target`. On Windows the
/// rename retries up to 3 times with exponential backoff before
/// surfacing the failure; the temp file is preserved on final failure
/// so a human can recover.
///
/// Idempotent in the sense that calling it twice with the same content
/// yields the same on-disk bytes. Not safe to call concurrently on the
/// same `target` — the temp path is fixed per target, so racing writers
/// would clobber each other's temp file.
///
/// `target` must have a parent directory that exists; this function
/// does not create directories.
pub fn atomic_write(target: &Path, content: &[u8]) -> Result<(), VaultError> {
    let tmp = temp_path_for(target);

    // Phase 1: write + fsync the temp file.
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(VaultError::Io)?;
        file.write_all(content).map_err(VaultError::Io)?;
        file.sync_all().map_err(VaultError::Io)?;
        // Explicit drop happens at end-of-scope; named for clarity.
        drop(file);
    }

    // Phase 2: rename with retry. POSIX `rename` is atomic and
    // non-blocking; the retry only matters on Windows where a locked
    // target can transiently reject the call.
    rename_with_retry(&tmp, target)
}

/// Build the temp path for a target — sibling file with the
/// `.cubical-tmp` suffix appended to the basename.
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
    // ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32),
    // ERROR_LOCK_VIOLATION (33). `raw_os_error` is the Win32 code on
    // Windows.
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

#[cfg(not(windows))]
fn is_transient_rename_error(_e: &std::io::Error) -> bool {
    // POSIX rename is atomic. There's no transient failure mode that
    // warrants retry on non-Windows.
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
