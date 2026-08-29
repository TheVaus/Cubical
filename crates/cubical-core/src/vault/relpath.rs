use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelPathError {
    #[error("empty path")]
    Empty,

    #[error("invalid vault path: {0}")]
    Invalid(String),

    #[error("path resolves outside the vault: {0}")]
    Outside(String),
}

pub(crate) fn to_vault_relative(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[must_use]
pub fn fold_name(name: &str) -> String {
    name.to_lowercase()
}

#[must_use]
pub fn names_eq_folded(a: &str, b: &str) -> bool {
    a == b || fold_name(a) == fold_name(b)
}

const SEPARATORS: [char; 2] = ['/', '\\'];

fn segment_ok(seg: &str) -> bool {
    if seg.is_empty() || seg == "." || seg == ".." {
        return false;
    }
    let bytes = seg.as_bytes();
    if bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let mut comps = Path::new(seg).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(name)), None) => name == OsStr::new(seg),
        _ => false,
    }
}

fn segments(raw: &str) -> Result<Vec<&str>, RelPathError> {
    if raw.contains('\0') {
        return Err(RelPathError::Invalid(raw.escape_debug().to_string()));
    }
    let mut lead = raw.chars();
    if lead.next().is_some_and(|c| SEPARATORS.contains(&c))
        && lead.next().is_some_and(|c| SEPARATORS.contains(&c))
    {
        return Err(RelPathError::Invalid(raw.to_string()));
    }
    let trimmed = raw.trim_matches(|c| SEPARATORS.contains(&c));
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let segs: Vec<&str> = trimmed.split(SEPARATORS).collect();
    if segs.iter().any(|s| !segment_ok(s)) {
        return Err(RelPathError::Invalid(raw.to_string()));
    }
    Ok(segs)
}

pub fn validate_rel_file(raw: &str) -> Result<String, RelPathError> {
    let segs = segments(raw)?;
    if segs.is_empty() {
        return Err(RelPathError::Empty);
    }
    Ok(segs.join("/"))
}

pub fn validate_rel_dir(raw: &str) -> Result<String, RelPathError> {
    Ok(segments(raw)?.join("/"))
}

pub fn contained_join(root: &Path, raw: &str) -> Result<(String, PathBuf), RelPathError> {
    let rel = validate_rel_file(raw)?;
    let abs = root.join(&rel);
    let base = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

    let mut probe: &Path = abs.as_path();
    let anchor = loop {
        if let Ok(resolved) = std::fs::canonicalize(probe) {
            break Some(resolved);
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break None,
        }
    };

    match anchor {
        Some(resolved) if resolved.starts_with(&base) => Ok((rel, abs)),
        _ => Err(RelPathError::Outside(rel)),
    }
}

#[must_use]
pub fn directory_holds_exact_name(abs: &Path) -> bool {
    let (Some(parent), Some(name)) = (abs.parent(), abs.file_name()) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return false;
    };
    entries
        .filter_map(Result::ok)
        .any(|e| e.file_name() == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_nested_path_uses_forward_slashes_on_every_platform() {
        let rel: PathBuf = ["projects", "2026", "note.md"].iter().collect();
        assert_eq!(to_vault_relative(&rel), "projects/2026/note.md");
    }

    #[test]
    fn a_single_segment_is_unchanged() {
        assert_eq!(to_vault_relative(Path::new("note.md")), "note.md");
    }

    #[test]
    fn a_plain_relative_path_survives() {
        assert_eq!(validate_rel_file("notes/plan.md").unwrap(), "notes/plan.md");
        assert_eq!(
            validate_rel_file("/notes/plan.md/").unwrap(),
            "notes/plan.md"
        );
    }

    #[test]
    fn dot_dot_is_rejected_through_either_separator() {
        for raw in [
            "../evil.md",
            "notes/../../evil.md",
            r"..\..\evil.md",
            r"notes\..\..\evil.md",
            "notes/..",
        ] {
            assert!(
                validate_rel_file(raw).is_err(),
                "expected rejection of {raw}"
            );
        }
    }

    #[test]
    fn a_windows_drive_or_unc_prefix_is_rejected_on_every_platform() {
        for raw in [
            "C:/evil.md",
            r"C:\evil.md",
            "c:/evil.md",
            r"\\server\share\x.md",
        ] {
            assert!(
                validate_rel_file(raw).is_err(),
                "expected rejection of {raw}"
            );
        }
    }

    #[test]
    fn a_colon_inside_a_name_is_not_a_drive_prefix() {
        assert_eq!(
            validate_rel_file("notes/C: A Study.md").unwrap(),
            "notes/C: A Study.md"
        );
    }

    #[test]
    fn an_interior_nul_is_rejected() {
        assert!(validate_rel_file("notes/pl\0an.md").is_err());
    }

    #[test]
    fn an_empty_file_path_is_rejected_but_an_empty_dir_is_the_vault_root() {
        assert_eq!(validate_rel_file(""), Err(RelPathError::Empty));
        assert_eq!(validate_rel_file("/"), Err(RelPathError::Empty));
        assert_eq!(validate_rel_dir("").unwrap(), "");
        assert_eq!(validate_rel_dir("/").unwrap(), "");
    }

    #[test]
    fn contained_join_accepts_a_path_that_does_not_exist_yet() {
        let dir = tempfile::tempdir().unwrap();
        let (rel, abs) = contained_join(dir.path(), "deep/new/note.md").unwrap();
        assert_eq!(rel, "deep/new/note.md");
        assert!(abs.starts_with(dir.path()));
    }

    #[test]
    fn contained_join_refuses_a_symlink_that_leaves_the_vault() {
        let outside = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let link = vault.path().join("escape");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path(), &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.path(), &link);
        if made.is_err() {
            return;
        }

        assert_eq!(
            contained_join(vault.path(), "escape/evil.md"),
            Err(RelPathError::Outside("escape/evil.md".into()))
        );
    }

    #[test]
    fn folding_is_unicode_aware_not_ascii_only() {
        assert!(names_eq_folded("CAFÉ", "café"));
        assert!(names_eq_folded("STRASSE", "strasse"));
        assert!(!names_eq_folded("café", "cafe"));
    }

    #[test]
    fn directory_holds_exact_name_distinguishes_a_case_only_collision() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.md"), b"x").unwrap();
        assert!(directory_holds_exact_name(&dir.path().join("note.md")));
        assert!(!directory_holds_exact_name(&dir.path().join("Note.md")));
    }
}
