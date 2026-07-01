//! Shared context-snippet helper for the sidebar panels (Backlinks +
//! Unlinked Mentions). Pure — no I/O, no DB. Lifted out of
//! `commands/backlinks.rs` in L3 Session I so both panels render
//! identical-looking context around a byte position.

/// Build a single-line context snippet around `position` in `source`.
///
/// Width is 120 bytes, centred on `position`. Newlines collapse to
/// spaces; runs of whitespace collapse to a single space; word
/// boundaries are preferred for trimming. UTF-8 boundaries are
/// respected — the helper never slices mid-codepoint.
///
/// Returns the empty string when `source` has no readable text.
pub fn build_snippet(source: &str, position: u64) -> String {
    const WIDTH: usize = 120;
    const HALF: usize = WIDTH / 2;
    const WORD_LOOKAHEAD: usize = 16;

    if source.is_empty() {
        return String::new();
    }

    let len = source.len();
    let pos = (position as usize).min(len);
    let raw_start = pos.saturating_sub(HALF);
    let raw_end = (pos + HALF).min(len);

    let start = char_boundary_floor(source, raw_start);
    let end = char_boundary_ceil(source, raw_end);

    let mut window: String = source[start..end].to_string();
    window = window.replace(['\n', '\r'], " ");

    let mut collapsed = String::with_capacity(window.len());
    let mut prev_space = false;
    for ch in window.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut snippet = trimmed.to_string();

    if start > 0 {
        let head: String = snippet.chars().take(WORD_LOOKAHEAD).collect();
        if let Some(space_idx) = head.find(' ') {
            let drop_to = space_idx + 1;
            snippet = format!("…{}", &snippet[drop_to..]);
        } else {
            snippet = format!("…{snippet}");
        }
    }
    if end < len {
        let snippet_len = snippet.len();
        let tail_start = snippet_len.saturating_sub(WORD_LOOKAHEAD);
        let tail = &snippet[tail_start..];
        if let Some(space_idx) = tail.rfind(' ') {
            let cut = tail_start + space_idx;
            snippet = format!("{}…", &snippet[..cut]);
        } else {
            snippet = format!("{snippet}…");
        }
    }
    snippet
}

fn char_boundary_floor(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn char_boundary_ceil(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_source_returns_empty() {
        assert_eq!(build_snippet("", 0), "");
    }

    #[test]
    fn short_source_returns_full_text_no_ellipses() {
        let s = "hello world";
        let got = build_snippet(s, 5);
        assert_eq!(got, "hello world");
    }

    #[test]
    fn near_start_no_leading_ellipsis() {
        let mut s = String::from("Lead text ");
        s.push_str(&"x".repeat(200));
        let got = build_snippet(&s, 0);
        assert!(got.starts_with("Lead text"), "got: {got}");
        assert!(got.ends_with('…'), "got: {got}");
    }

    #[test]
    fn near_end_no_trailing_ellipsis() {
        let mut s = String::from(&"x".repeat(200));
        s.push_str(" trailing words");
        let pos = (s.len() - 5) as u64;
        let got = build_snippet(&s, pos);
        assert!(got.starts_with('…'), "got: {got}");
        assert!(got.ends_with("trailing words"), "got: {got}");
    }

    #[test]
    fn middle_position_has_both_ellipses() {
        let s = "a".repeat(200) + " word " + &"b".repeat(200);
        let pos = 200u64;
        let got = build_snippet(&s, pos);
        assert!(got.starts_with('…') && got.ends_with('…'), "got: {got}");
    }

    #[test]
    fn newlines_collapse_to_single_spaces() {
        let s = "alpha\n\nbeta\r\ngamma";
        let got = build_snippet(s, 0);
        assert!(!got.contains('\n'));
        assert!(!got.contains('\r'));
        assert_eq!(got, "alpha beta gamma");
    }

    #[test]
    fn runs_of_whitespace_collapse() {
        let s = "alpha    beta\t\t  gamma";
        let got = build_snippet(s, 0);
        assert_eq!(got, "alpha beta gamma");
    }

    #[test]
    fn utf8_does_not_panic_at_boundary() {
        let s = "héllo wörld ".repeat(30);
        let _ = build_snippet(&s, 61);
    }

    #[test]
    fn position_beyond_source_clamps_to_end() {
        let s = "short text";
        let got = build_snippet(s, 9_999);
        assert_eq!(got, "short text");
    }
}
