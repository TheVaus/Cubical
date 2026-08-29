use std::path::{Path, PathBuf};

use cubical_core::vault::{relpath, RelPathError};
use cubical_core::Vault;

use crate::error::CubicalError;

fn reject(e: RelPathError) -> CubicalError {
    CubicalError::InvalidRequest(e.to_string())
}

pub(crate) fn rel_dir(raw: &str) -> Result<String, CubicalError> {
    relpath::validate_rel_dir(raw).map_err(reject)
}

pub(crate) fn vault_file(vault: &Vault, raw: &str) -> Result<(String, PathBuf), CubicalError> {
    relpath::contained_join(vault.root(), raw).map_err(reject)
}

pub(crate) fn is_vacant(counterpart_rel: &str, rel: &str, abs: &Path) -> bool {
    if !abs.exists() {
        return true;
    }
    counterpart_rel != rel
        && cubical_index::names_eq_folded(counterpart_rel, rel)
        && relpath::directory_holds_exact_name(abs) == Some(false)
}

pub(crate) fn vault_dir(vault: &Vault, raw: &str) -> Result<(String, PathBuf), CubicalError> {
    let rel = rel_dir(raw)?;
    if rel.is_empty() {
        return Ok((rel, vault.root().to_path_buf()));
    }
    vault_file(vault, &rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_whose_only_occupant_is_its_counterpart_under_another_spelling_is_vacant() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Note.md"), b"x").unwrap();
        let folded = dir.path().join("note.md");

        assert!(
            is_vacant("Note.md", "note.md", &folded),
            "the source spelling holds no real entry once the file is Note.md",
        );
        if folded.exists() {
            assert!(
                !relpath::directory_holds_exact_name(&folded).unwrap(),
                "this volume folds case, so exists() answers for Note.md and only \
                 the directory's real entries can tell the two apart",
            );
        }
        assert!(
            !is_vacant("Note.md", "Note.md", &dir.path().join("Note.md")),
            "a path is never vacant against itself",
        );
        assert!(
            is_vacant("Note.md", "absent.md", &dir.path().join("absent.md")),
            "a path with nothing at it is vacant",
        );
        std::fs::write(dir.path().join("other.md"), b"x").unwrap();
        assert!(
            !is_vacant("Note.md", "other.md", &dir.path().join("other.md")),
            "a genuinely distinct file occupies its path",
        );
    }
}
