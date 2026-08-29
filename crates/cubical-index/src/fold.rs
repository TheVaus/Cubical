#[must_use]
pub fn fold_name(name: &str) -> String {
    name.to_lowercase()
}

#[must_use]
pub fn names_eq_folded(a: &str, b: &str) -> bool {
    a == b || fold_name(a) == fold_name(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_is_unicode_aware_not_ascii_only() {
        assert!(names_eq_folded("CAFÉ", "café"));
        assert!(names_eq_folded("STRASSE", "strasse"));
        assert!(!names_eq_folded("café", "cafe"));
    }
}
