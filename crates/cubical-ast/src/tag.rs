#[derive(Debug, Clone, PartialEq)]
pub enum TokenizedRun {
    Text(String),
    Tag { path: String },
}

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

fn is_body_start(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'_')
}

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
        assert_eq!(scan_tags("##foo"), vec![text("##foo")]);
    }
}
