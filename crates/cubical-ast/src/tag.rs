//! Pure inline-tag tokenizer. Scans an `Inline::Text` value for `#tag`
//! runs (incl. nested `#parent/child`) and yields a sequence of
//! `TokenizedRun`s.
//!
//! Grammar mirrors the wiki-link tokenizer's shape (`wikilink.rs`) so
//! both halves of the inline-token split pass agree on `Text` / token /
//! `Text` boundaries. Mirrored byte-for-byte in `ui/src/ast/tag.ts`;
//! the L1 parity harness extends to tag fixtures so the two stay in
//! lockstep.
//!
//! Word-boundary rule: a `#` only opens a tag when it sits at the very
//! start of the text run or directly follows an ASCII whitespace byte
//! (space, tab, newline). This is the load-bearing rule that keeps
//! `prefix#tag` from being a tag and lets `text #tag` be one.
//!
//! Tag-body rule: after the `#`, the first byte must be ASCII letter or
//! `_` (no leading digit — `#123` is just a hash followed by a number,
//! not a tag). Subsequent body bytes may be `[a-zA-Z0-9_-]`; nesting is
//! a single `/` followed by a non-empty segment of the same body
//! alphabet. Trailing `/` is trimmed (treated as text from the slash on).

/// One run produced by [`scan_tags`].
#[derive(Debug, Clone, PartialEq)]
pub enum TokenizedRun {
    /// Plain text between (or around) tags.
    Text(String),
    /// A successfully parsed tag. `path` is the body without the leading
    /// `#`, e.g. `"todo"` or `"project/cubical"`.
    Tag {
        /// Tag body with the leading `#` stripped, including any nested
        /// `/`-separated segments.
        path: String,
    },
}

/// Scan a text run for `#tag` / `#nested/tag` occurrences. Always
/// returns at least one element when `input` is non-empty (a single
/// `Text` if no tags are found). An empty input returns an empty `Vec`.
pub fn scan_tags(input: &str) -> Vec<TokenizedRun> {
    if input.is_empty() {
        return Vec::new();
    }
    let bytes = input.as_bytes();
    let mut out: Vec<TokenizedRun> = Vec::new();
    let mut cursor: usize = 0;
    let mut i: usize = 0;
    while i < bytes.len() {
        if bytes[i] != b'#' {
            i += 1;
            continue;
        }
        // Word-boundary: must be at run-start or after ASCII whitespace.
        if i > 0 && !is_ascii_ws(bytes[i - 1]) {
            i += 1;
            continue;
        }
        match parse_body(bytes, i + 1) {
            Some(end) => {
                if i > cursor {
                    out.push(TokenizedRun::Text(input[cursor..i].to_string()));
                }
                out.push(TokenizedRun::Tag {
                    path: input[i + 1..end].to_string(),
                });
                cursor = end;
                i = end;
            }
            None => {
                i += 1;
            }
        }
    }
    if cursor < bytes.len() {
        out.push(TokenizedRun::Text(input[cursor..].to_string()));
    }
    out
}

/// Walk forward from `start` (the byte right after the `#`). Returns
/// the exclusive end byte of a valid tag body, or `None` if the body
/// is empty / starts with an invalid character / is a bare digit run.
fn parse_body(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() {
        return None;
    }
    let first = bytes[start];
    if !is_body_start(first) {
        return None;
    }
    let mut i = start + 1;
    while i < bytes.len() {
        let b = bytes[i];
        if is_body_cont(b) {
            i += 1;
        } else if b == b'/' {
            // Nested segment: `/` must be followed by at least one
            // body-continuation byte. If not, stop at the slash (it
            // and what follows become text again).
            if i + 1 < bytes.len() && is_body_cont(bytes[i + 1]) {
                i += 2;
                while i < bytes.len() && is_body_cont(bytes[i]) {
                    i += 1;
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }
    Some(i)
}

fn is_ascii_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// First byte of a tag body: ASCII letter or underscore. Digits are
/// rejected so `#123` doesn't parse as a tag (Obsidian / Bear / Logseq
/// all converge on "tags are not pure numbers").
fn is_body_start(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'_')
}

/// Continuation byte of a tag body / segment: ASCII alphanumeric,
/// underscore, or hyphen. The `/` nesting separator is handled
/// explicitly in [`parse_body`].
fn is_body_cont(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(p: &str) -> TokenizedRun {
        TokenizedRun::Tag { path: p.into() }
    }

    fn text(s: &str) -> TokenizedRun {
        TokenizedRun::Text(s.into())
    }

    #[test]
    fn empty_input_returns_empty_vec() {
        assert_eq!(scan_tags(""), Vec::<TokenizedRun>::new());
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(scan_tags("just words"), vec![text("just words")]);
    }

    #[test]
    fn simple_tag_at_run_start() {
        assert_eq!(scan_tags("#todo"), vec![tag("todo")]);
    }

    #[test]
    fn tag_after_space() {
        assert_eq!(
            scan_tags("a #todo b"),
            vec![text("a "), tag("todo"), text(" b")]
        );
    }

    #[test]
    fn hash_after_word_is_not_a_tag() {
        assert_eq!(scan_tags("issue#42"), vec![text("issue#42")]);
    }

    #[test]
    fn nested_tag_is_one_token() {
        assert_eq!(scan_tags("#project/cubical"), vec![tag("project/cubical")]);
    }

    #[test]
    fn deeper_nesting_is_one_token() {
        assert_eq!(scan_tags("#a/b/c"), vec![tag("a/b/c")]);
    }

    #[test]
    fn trailing_slash_is_not_part_of_tag() {
        assert_eq!(scan_tags("#a/"), vec![tag("a"), text("/")]);
    }

    #[test]
    fn empty_segment_breaks_nesting() {
        assert_eq!(scan_tags("#a//b"), vec![tag("a"), text("//b")]);
    }

    #[test]
    fn bare_hash_is_text() {
        assert_eq!(scan_tags("#"), vec![text("#")]);
    }

    #[test]
    fn hash_followed_by_space_is_text() {
        assert_eq!(scan_tags("# heading"), vec![text("# heading")]);
    }

    #[test]
    fn hash_followed_by_digit_is_text() {
        assert_eq!(scan_tags("#42"), vec![text("#42")]);
    }

    #[test]
    fn underscore_starts_tag() {
        assert_eq!(scan_tags("#_draft"), vec![tag("_draft")]);
    }

    #[test]
    fn body_allows_alphanumeric_underscore_hyphen() {
        assert_eq!(scan_tags("#a1_b-c"), vec![tag("a1_b-c")]);
    }

    #[test]
    fn multiple_tags_in_one_run() {
        assert_eq!(
            scan_tags("#one #two #three"),
            vec![tag("one"), text(" "), tag("two"), text(" "), tag("three"),]
        );
    }

    #[test]
    fn tag_after_newline() {
        assert_eq!(scan_tags("first\n#tag"), vec![text("first\n"), tag("tag")]);
    }

    #[test]
    fn tag_after_tab() {
        assert_eq!(scan_tags("a\t#x"), vec![text("a\t"), tag("x")]);
    }

    #[test]
    fn tag_with_punctuation_after() {
        assert_eq!(scan_tags("#todo."), vec![tag("todo"), text(".")]);
    }

    #[test]
    fn double_hash_is_not_a_tag() {
        // `##foo` — the first `#` sees `#` (not body-start), the second
        // `#` sees a preceding non-whitespace byte (the first `#`).
        assert_eq!(scan_tags("##foo"), vec![text("##foo")]);
    }
}
