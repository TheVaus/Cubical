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
    let (rel, abs) = relpath::contained_join(vault.root(), raw).map_err(reject)?;
    if relpath::is_excluded(Path::new(&rel)) || resolves_into_excluded(vault.root(), &abs) {
        return Err(CubicalError::InvalidRequest(format!(
            "path is hidden from the vault: {rel}"
        )));
    }
    Ok((rel, abs))
}

fn resolves_into_excluded(root: &Path, abs: &Path) -> bool {
    let Ok(base) = std::fs::canonicalize(root) else {
        return false;
    };
    let anchor = abs.ancestors().find_map(|p| std::fs::canonicalize(p).ok());
    anchor
        .as_deref()
        .and_then(|a| a.strip_prefix(&base).ok())
        .is_some_and(relpath::is_excluded)
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

    async fn open_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.unwrap();
        (dir, vault)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_visible_symlink_into_a_hidden_folder_is_refused() {
        let (dir, vault) = open_vault().await;
        std::os::unix::fs::symlink(dir.path().join(".cubical"), dir.path().join("meta")).unwrap();
        assert!(vault_file(&vault, "meta/index.db").is_err());
        assert!(vault_file(&vault, "meta").is_err());
        assert!(vault_file(&vault, "notes/new.md").is_ok());
    }

    #[tokio::test]
    async fn a_path_with_a_hidden_component_is_refused() {
        let (_dir, vault) = open_vault().await;
        for raw in [
            ".note.md",
            "sub/.note.md",
            ".cubical/index.db",
            ".git",
            "node_modules/x.md",
            "note.md.cubical-tmp",
        ] {
            assert!(
                matches!(
                    vault_file(&vault, raw),
                    Err(CubicalError::InvalidRequest(_))
                ),
                "{raw} must be refused",
            );
        }
        assert!(matches!(
            vault_dir(&vault, ".cubical"),
            Err(CubicalError::InvalidRequest(_))
        ));
        assert_eq!(vault_file(&vault, "sub/note.md").unwrap().0, "sub/note.md");
        assert_eq!(vault_dir(&vault, "").unwrap().0, "");
    }

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
