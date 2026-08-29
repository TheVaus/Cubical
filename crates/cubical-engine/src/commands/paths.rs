use std::path::PathBuf;

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

pub(crate) fn destination_is_free(from_rel: &str, to_rel: &str, to_abs: &std::path::Path) -> bool {
    if !to_abs.exists() {
        return true;
    }
    from_rel != to_rel
        && relpath::names_eq_folded(from_rel, to_rel)
        && !relpath::directory_holds_exact_name(to_abs)
}

pub(crate) fn vault_dir(vault: &Vault, raw: &str) -> Result<(String, PathBuf), CubicalError> {
    let rel = rel_dir(raw)?;
    if rel.is_empty() {
        return Ok((rel, vault.root().to_path_buf()));
    }
    vault_file(vault, &rel)
}
