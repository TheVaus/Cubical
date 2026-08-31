#[must_use]
pub fn strip_markdown_extension(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

#[must_use]
pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[must_use]
pub fn note_title(path: &str) -> &str {
    strip_markdown_extension(basename(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: [(&str, &str, &str, &str); 9] = [
        ("note.md", "note", "note", "note.md"),
        ("folder/note.md", "note", "folder/note", "note.md"),
        ("notes.txt", "notes.txt", "notes.txt", "notes.txt"),
        ("a.b.md", "a.b", "a.b", "a.b.md"),
        (
            "no-extension",
            "no-extension",
            "no-extension",
            "no-extension",
        ),
        (".hidden", ".hidden", ".hidden", ".hidden"),
        (
            "assets/diagram.png",
            "diagram.png",
            "assets/diagram.png",
            "diagram.png",
        ),
        ("a/b/c.md", "c", "a/b/c", "c.md"),
        ("", "", "", ""),
    ];

    #[test]
    fn the_three_forms_agree_with_the_table() {
        for (path, title, stripped, base) in CASES {
            assert_eq!(note_title(path), title, "note_title({path})");
            assert_eq!(
                strip_markdown_extension(path),
                stripped,
                "strip_markdown_extension({path})"
            );
            assert_eq!(basename(path), base, "basename({path})");
        }
    }

    #[test]
    fn only_a_trailing_md_is_removed() {
        assert_eq!(note_title("note.md.txt"), "note.md.txt");
        assert_eq!(note_title("note.MD"), "note.MD");
        assert_eq!(note_title("md"), "md");
        assert_eq!(note_title(".md"), "");
    }
}
