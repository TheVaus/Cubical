//! On-demand unlinked-mention scanner (L3 Session I, spec §2.9).
//!
//! Pure: no I/O, no DB. Walks markdown source to find plain-text
//! regions (skipping frontmatter, fenced/inline code, wiki-links,
//! and markdown links), then matches needles against those regions
//! with whole-word case-insensitive comparison.

/// A contiguous slice of source bytes that is plain text — i.e. NOT
/// inside frontmatter, fenced code, inline code, a wiki-link, or a
/// markdown link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRun<'a> {
    /// Byte offset into the original source where this run begins.
    pub start: u64,
    /// The slice itself (borrowed from the source).
    pub slice: &'a str,
}

/// Walk `source` and yield every plain-text run, in source order.
pub fn extract_text_runs(source: &str) -> Vec<TextRun<'_>> {
    if source.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor: usize = 0;
    let mut i: usize = 0;
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut in_fence = false;
    let mut fence_marker: &str = "";

    // Frontmatter: a `---\n` at byte 0, terminated by the next `\n---\n`
    // or `\n---` at end of file. Mirrors `cubical_ast::split_frontmatter`
    // semantics at the byte level — we only need to find the end offset.
    if source.starts_with("---\n") || source.starts_with("---\r\n") {
        let after_open = if source.starts_with("---\r\n") { 5 } else { 4 };
        // Find next line beginning with `---` followed by EOL or EOF.
        let mut probe = after_open;
        while probe < len {
            // Line start position.
            let line_start = probe;
            // Advance probe to end of line.
            while probe < len && bytes[probe] != b'\n' {
                probe += 1;
            }
            let line = &source[line_start..probe];
            let trimmed = line.trim_end_matches('\r');
            if trimmed == "---" || trimmed == "..." {
                // Skip past the close (include the trailing newline if any).
                cursor = probe + if probe < len { 1 } else { 0 };
                i = cursor;
                break;
            }
            if probe < len {
                probe += 1; // step past the '\n'
            }
        }
        if cursor == 0 {
            // No close found — treat whole file as frontmatter (degenerate).
            return Vec::new();
        }
    }

    let mut line_start = i;
    let mut at_line_start = true;

    while i < len {
        let b = bytes[i];

        // Line tracking.
        if b == b'\n' {
            i += 1;
            line_start = i;
            at_line_start = true;
            continue;
        }

        // Fence open/close — check only at the start of a line.
        if at_line_start {
            // Skip leading spaces (up to 3 — CommonMark allows that).
            let mut j = i;
            let mut spaces = 0;
            while j < len && bytes[j] == b' ' && spaces < 4 {
                j += 1;
                spaces += 1;
            }
            if !in_fence {
                if source[j..].starts_with("```") || source[j..].starts_with("~~~") {
                    // Flush any pending text run up to line_start.
                    push_run(&mut out, source, cursor, line_start);
                    in_fence = true;
                    fence_marker = if source[j..].starts_with("```") {
                        "```"
                    } else {
                        "~~~"
                    };
                    // Skip to end of line.
                    while i < len && bytes[i] != b'\n' {
                        i += 1;
                    }
                    if i < len {
                        i += 1;
                    }
                    cursor = i;
                    line_start = i;
                    at_line_start = true;
                    continue;
                }
            } else if source[j..].starts_with(fence_marker) {
                in_fence = false;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
                if i < len {
                    i += 1;
                }
                cursor = i;
                line_start = i;
                at_line_start = true;
                continue;
            }
            at_line_start = false;
        }

        if in_fence {
            i += 1;
            continue;
        }

        // Inline code span — opening backtick run. Skip over until a
        // matching-length run closes it. CommonMark allows `…`, ``…``, etc.
        if b == b'`' {
            let mut tick_len = 0;
            while i + tick_len < len && bytes[i + tick_len] == b'`' {
                tick_len += 1;
            }
            // Find a closing run of the same length on the same or
            // subsequent lines (CommonMark allows multi-line code spans).
            let scan_start = i + tick_len;
            let mut close = scan_start;
            let mut found_close = None;
            while close < len {
                if bytes[close] == b'`' {
                    let mut run = 0;
                    while close + run < len && bytes[close + run] == b'`' {
                        run += 1;
                    }
                    if run == tick_len {
                        found_close = Some(close);
                        break;
                    }
                    close += run;
                } else {
                    close += 1;
                }
            }
            match found_close {
                Some(end) => {
                    push_run(&mut out, source, cursor, i);
                    let after = end + tick_len;
                    cursor = after;
                    i = after;
                    continue;
                }
                None => {
                    // Unterminated — treat the backticks as literal text.
                    i += tick_len;
                    continue;
                }
            }
        }

        // Wiki-link / embed.
        if b == b'[' && i + 1 < len && bytes[i + 1] == b'[' {
            // Look back: an immediately-preceding `!` makes this an embed
            // and the run's exclusion zone starts at the `!`.
            let opener_start = if i > 0 && bytes[i - 1] == b'!' { i - 1 } else { i };
            // Find matching `]]`.
            let mut j = i + 2;
            let mut close = None;
            while j + 1 < len {
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    close = Some(j + 2);
                    break;
                }
                j += 1;
            }
            if let Some(after_close) = close {
                push_run(&mut out, source, cursor, opener_start);
                cursor = after_close;
                i = after_close;
                continue;
            }
            // Unterminated wiki-link → fall through and treat as text.
        }

        // Markdown link `[display](url)` — skip both segments.
        if b == b'[' {
            // Find matching `]`.
            let mut j = i + 1;
            let mut depth = 1;
            while j < len {
                match bytes[j] {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            if j < len && bytes[j] == b']' && j + 1 < len && bytes[j + 1] == b'(' {
                // Find the matching `)`.
                let mut k = j + 2;
                while k < len && bytes[k] != b')' {
                    k += 1;
                }
                if k < len {
                    push_run(&mut out, source, cursor, i);
                    cursor = k + 1;
                    i = k + 1;
                    continue;
                }
            }
        }

        i += 1;
    }

    let _ = line_start;
    push_run(&mut out, source, cursor, len);
    out
}

fn push_run<'a>(out: &mut Vec<TextRun<'a>>, source: &'a str, start: usize, end: usize) {
    if end > start {
        out.push(TextRun {
            start: start as u64,
            slice: &source[start..end],
        });
    }
}

/// One needle occurrence found inside a text run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionHit {
    /// Which needle in the caller's slice matched (so the caller can
    /// distinguish title vs. alias).
    pub needle_index: usize,
    /// Byte offset into the original source where the match starts.
    pub byte_offset: u64,
    /// Length in bytes of the matched span.
    pub byte_len: u64,
}

/// Find every whole-word case-insensitive occurrence of any `needle`
/// in the plain-text regions of `source`. Empty / whitespace-only /
/// whitespace-containing needles are skipped silently.
pub fn find_mention_occurrences(source: &str, needles: &[&str]) -> Vec<MentionHit> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_slices<'a>(runs: &'a [TextRun<'a>]) -> Vec<&'a str> {
        runs.iter().map(|r| r.slice).collect()
    }

    // ---- extract_text_runs ---------------------------------------

    #[test]
    fn empty_source_yields_no_runs() {
        assert!(extract_text_runs("").is_empty());
    }

    #[test]
    fn plain_paragraph_is_one_run() {
        let runs = extract_text_runs("hello world\n");
        assert_eq!(run_slices(&runs), vec!["hello world\n"]);
        assert_eq!(runs[0].start, 0);
    }

    #[test]
    fn frontmatter_block_is_skipped() {
        let src = "---\ntitle: Foo\n---\nbody text\n";
        let runs = extract_text_runs(src);
        let joined: String = runs.iter().map(|r| r.slice).collect();
        assert!(!joined.contains("title:"), "frontmatter leaked: {joined:?}");
        assert!(joined.contains("body text"));
    }

    #[test]
    fn fenced_code_is_skipped() {
        let src = "before\n```\nDaily inside fence\n```\nafter Daily\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(!joined.contains("inside fence"), "fenced leaked: {joined:?}");
        assert!(joined.contains("after Daily"));
    }

    #[test]
    fn inline_code_span_is_skipped() {
        let src = "see `daily` for context and Daily again\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        // The plain text outside the span survives.
        assert!(joined.contains("see "));
        assert!(joined.contains("Daily again"));
        // The span's interior does not.
        assert!(!joined.contains("`daily`"));
    }

    #[test]
    fn wikilink_body_is_skipped() {
        let src = "text [[Daily]] more text\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(joined.contains("text "));
        assert!(joined.contains(" more text"));
        assert!(!joined.contains("Daily"), "wiki-link leaked: {joined:?}");
    }

    #[test]
    fn embed_wikilink_body_is_skipped() {
        let src = "text ![[Daily]] more\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(!joined.contains("Daily"));
    }

    #[test]
    fn markdown_link_display_and_url_are_skipped() {
        let src = "see [Daily](daily.md) here\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(joined.contains("see "));
        assert!(joined.contains(" here"));
        assert!(!joined.contains("Daily"));
        assert!(!joined.contains("daily.md"));
    }

    #[test]
    fn text_runs_preserve_byte_offsets() {
        // "hello [[Daily]] world" — runs at 0 ("hello ") and 15 (" world\n").
        let runs = extract_text_runs("hello [[Daily]] world\n");
        let starts: Vec<u64> = runs.iter().map(|r| r.start).collect();
        assert_eq!(starts.first().copied(), Some(0));
        // Second run starts after the closing ]] which ends at byte 15.
        assert!(starts.contains(&15), "starts: {starts:?}");
    }
}
