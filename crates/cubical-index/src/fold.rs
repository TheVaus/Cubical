#[must_use]
pub fn fold_name(name: &str) -> String {
    name.to_lowercase()
}

#[must_use]
pub fn names_eq_folded(a: &str, b: &str) -> bool {
    a == b || fold_name(a) == fold_name(b)
}

#[must_use]
pub fn fold_prefix_upper_bound(prefix: &str) -> Option<String> {
    let mut head = prefix.to_string();
    while let Some(last) = head.pop() {
        let mut next = u32::from(last) + 1;
        if next == 0xD800 {
            next = 0xE000;
        }
        if let Some(bumped) = char::from_u32(next) {
            head.push(bumped);
            return Some(head);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upper_bound_excludes_exactly_the_prefix_and_nothing_shorter() {
        assert_eq!(fold_prefix_upper_bound("a").as_deref(), Some("b"));
        assert_eq!(fold_prefix_upper_bound("a/").as_deref(), Some("a0"));
        assert_eq!(fold_prefix_upper_bound("café").as_deref(), Some("cafê"));
        assert_eq!(fold_prefix_upper_bound("az").as_deref(), Some("a{"));
        assert_eq!(fold_prefix_upper_bound("").as_deref(), None);
        assert_eq!(fold_prefix_upper_bound("a\u{10FFFF}").as_deref(), Some("b"));
        assert_eq!(
            fold_prefix_upper_bound("a\u{D7FF}").as_deref(),
            Some("a\u{E000}")
        );
    }

    #[test]
    fn folding_is_unicode_aware_not_ascii_only() {
        assert!(names_eq_folded("CAFÉ", "café"));
        assert!(names_eq_folded("STRASSE", "strasse"));
        assert!(!names_eq_folded("café", "cafe"));
    }
}
