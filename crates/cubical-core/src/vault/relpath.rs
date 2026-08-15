use std::path::{Component, Path};

pub(crate) fn to_vault_relative(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
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
}
