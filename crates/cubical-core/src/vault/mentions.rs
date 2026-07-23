#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRun<'a> {
    pub start: u64,
    pub slice: &'a str,
}

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

    if source.starts_with("---\n") || source.starts_with("---\r\n") {
        let after_open = if source.starts_with("---\r\n") { 5 } else { 4 };
        let mut probe = after_open;
        while probe < len {
            let line_start = probe;
            while probe < len && bytes[probe] != b'\n' {
                probe += 1;
            }
            let line = &source[line_start..probe];
            let trimmed = line.trim_end_matches('\r');
            if trimmed == "---" || trimmed == "..." {
                cursor = probe + if probe < len { 1 } else { 0 };
                i = cursor;
                break;
            }
            if probe < len {
                probe += 1;
            }
        }
        if cursor == 0 {
            return Vec::new();
        }
    }

    #[allow(unused_assignments)]
    let mut line_start = i;
    let mut at_line_start = true;

    while i < len {
        let b = bytes[i];

        if b == b'\n' {
            i += 1;
            line_start = i;
            at_line_start = true;
            continue;
        }

        if at_line_start {
            let mut j = i;
            let mut spaces = 0;
            while j < len && bytes[j] == b' ' && spaces < 4 {
                j += 1;
                spaces += 1;
            }
            if !in_fence {
                if source[j..].starts_with("```") || source[j..].starts_with("~~~") {
                    push_run(&mut out, source, cursor, line_start);
                    in_fence = true;
                    fence_marker = if source[j..].starts_with("```") {
                        "```"
                    } else {
                        "~~~"
                    };
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

        if b == b'`' {
            let mut tick_len = 0;
            while i + tick_len < len && bytes[i + tick_len] == b'`' {
                tick_len += 1;
            }
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
                    i += tick_len;
                    continue;
                }
            }
        }

        if b == b'[' && i + 1 < len && bytes[i + 1] == b'[' {
            let opener_start = if i > 0 && bytes[i - 1] == b'!' {
                i - 1
            } else {
                i
            };
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
        }

        if b == b'[' {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionHit {
    pub needle_index: usize,
    pub byte_offset: u64,
    pub byte_len: u64,
}

pub fn find_mention_occurrences(source: &str, needles: &[&str]) -> Vec<MentionHit> {
    let prepared: Vec<(usize, String, usize)> = needles
        .iter()
        .enumerate()
        .filter_map(|(idx, n)| {
            let trimmed = n.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some((idx, trimmed.to_lowercase(), trimmed.len()))
        })
        .collect();
    if prepared.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    for run in extract_text_runs(source) {
        let run_lower = run.slice.to_lowercase();
        for (needle_idx, needle_lower, _needle_byte_len) in &prepared {
            let mut search_from = 0usize;
            while search_from <= run_lower.len() {
                let Some(rel) = run_lower[search_from..].find(needle_lower) else {
                    break;
                };
                let match_start = search_from + rel;
                let match_end = match_start + needle_lower.len();

                if is_word_boundary(&run_lower, match_start, match_end) {
                    let (orig_start, orig_len) =
                        map_lower_span_to_original(run.slice, &run_lower, match_start, match_end);
                    out.push(MentionHit {
                        needle_index: *needle_idx,
                        byte_offset: run.start + orig_start as u64,
                        byte_len: orig_len as u64,
                    });
                    search_from = match_end;
                } else {
                    let step = run_lower[match_start..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(1);
                    search_from = match_start + step;
                }
            }
        }
    }
    out.sort_by_key(|h| h.byte_offset);
    out
}

fn is_word_boundary(s: &str, start: usize, end: usize) -> bool {
    let before_ok = match s[..start].chars().next_back() {
        None => true,
        Some(c) => !is_word_char(c),
    };
    let after_ok = match s[end..].chars().next() {
        None => true,
        Some(c) => !is_word_char(c),
    };
    before_ok && after_ok
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn map_lower_span_to_original(
    original: &str,
    lower: &str,
    match_start: usize,
    match_end: usize,
) -> (usize, usize) {
    let mut orig_iter = original.char_indices();
    let mut lower_iter = lower.char_indices();
    let mut orig_start = 0usize;
    let mut orig_end = original.len();
    let mut found_start = false;
    loop {
        match (orig_iter.next(), lower_iter.next()) {
            (Some((oi, oc)), Some((li, _))) => {
                if !found_start && li >= match_start {
                    orig_start = oi;
                    found_start = true;
                }
                if li >= match_end {
                    orig_end = oi;
                    break;
                }
                let lowered_len: usize = oc.to_lowercase().map(|c| c.len_utf8()).sum();
                if lowered_len > oc.len_utf8() {
                    let extra = lowered_len - oc.len_utf8();
                    let mut skipped = 0usize;
                    while skipped < extra {
                        if let Some((_, lc)) = lower_iter.next() {
                            skipped += lc.len_utf8();
                        } else {
                            break;
                        }
                    }
                }
            }
            (Some((oi, _)), None) => {
                orig_end = oi;
                break;
            }
            (None, _) => break,
        }
    }
    if !found_start {
        orig_start = original.len();
    }
    (orig_start, orig_end.saturating_sub(orig_start))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_slices<'a>(runs: &'a [TextRun<'a>]) -> Vec<&'a str> {
        runs.iter().map(|r| r.slice).collect()
    }

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
        let joined: String = extract_text_runs(src).iter().map(|r| r.slice).collect();
        assert!(
            !joined.contains("inside fence"),
            "fenced leaked: {joined:?}"
        );
        assert!(joined.contains("after Daily"));
    }

    #[test]
    fn inline_code_span_is_skipped() {
        let src = "see `daily` for context and Daily again\n";
        let joined: String = extract_text_runs(src).iter().map(|r| r.slice).collect();
        assert!(joined.contains("see "));
        assert!(joined.contains("Daily again"));
        assert!(!joined.contains("`daily`"));
    }

    #[test]
    fn wikilink_body_is_skipped() {
        let src = "text [[Daily]] more text\n";
        let joined: String = extract_text_runs(src).iter().map(|r| r.slice).collect();
        assert!(joined.contains("text "));
        assert!(joined.contains(" more text"));
        assert!(!joined.contains("Daily"), "wiki-link leaked: {joined:?}");
    }

    #[test]
    fn embed_wikilink_body_is_skipped() {
        let src = "text ![[Daily]] more\n";
        let joined: String = extract_text_runs(src).iter().map(|r| r.slice).collect();
        assert!(!joined.contains("Daily"));
    }

    #[test]
    fn markdown_link_display_and_url_are_skipped() {
        let src = "see [Daily](daily.md) here\n";
        let joined: String = extract_text_runs(src).iter().map(|r| r.slice).collect();
        assert!(joined.contains("see "));
        assert!(joined.contains(" here"));
        assert!(!joined.contains("Daily"));
        assert!(!joined.contains("daily.md"));
    }

    #[test]
    fn text_runs_preserve_byte_offsets() {
        let runs = extract_text_runs("hello [[Daily]] world\n");
        let starts: Vec<u64> = runs.iter().map(|r| r.start).collect();
        assert_eq!(starts.first().copied(), Some(0));
        assert!(starts.contains(&15), "starts: {starts:?}");
    }

    fn hit_slice<'a>(src: &'a str, hit: &MentionHit) -> &'a str {
        let s = hit.byte_offset as usize;
        let e = s + hit.byte_len as usize;
        &src[s..e]
    }

    #[test]
    fn finds_simple_whole_word_match_case_insensitive() {
        let src = "I worked on the Daily today.\n";
        let hits = find_mention_occurrences(src, &["daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hit_slice(src, &hits[0]), "Daily");
        assert_eq!(hits[0].needle_index, 0);
    }

    #[test]
    fn rejects_substring_inside_a_larger_word() {
        let src = "ordinarily this counts but ordinariness does not\n";
        let hits = find_mention_occurrences(src, &["dinari"]);
        assert!(hits.is_empty(), "substring leaked: {hits:?}");
    }

    #[test]
    fn boundary_treats_hyphen_as_non_word() {
        let src = "see Daily-Note for details\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hit_slice(src, &hits[0]), "Daily");
    }

    #[test]
    fn boundary_treats_underscore_as_word_so_underscore_blocks_match() {
        let src = "see Daily_Notes for details\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert!(
            hits.is_empty(),
            "underscore should block whole-word match: {hits:?}"
        );
    }

    #[test]
    fn multiple_needles_one_call() {
        let src = "Daily and Journal both belong here.\n";
        let hits = find_mention_occurrences(src, &["Daily", "Journal"]);
        let needles: Vec<usize> = hits.iter().map(|h| h.needle_index).collect();
        assert!(needles.contains(&0));
        assert!(needles.contains(&1));
    }

    #[test]
    fn empty_or_whitespace_needles_silently_dropped() {
        let src = "text here\n";
        let hits = find_mention_occurrences(src, &["", "  ", "text"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].needle_index, 2);
    }

    #[test]
    fn needle_with_internal_space_is_supported() {
        let src = "see Project Alpha for the spec\n";
        let hits = find_mention_occurrences(src, &["Project Alpha"]);
        assert_eq!(hits.len(), 1, "multi-word needle should match");
    }

    #[test]
    fn match_inside_code_block_is_excluded() {
        let src = "```\nDaily here\n```\nDaily there\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].byte_offset, "```\nDaily here\n```\n".len() as u64);
    }

    #[test]
    fn match_inside_wikilink_is_excluded() {
        let src = "[[Daily]] and Daily mention\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hit_slice(src, &hits[0]), "Daily");
        assert!(hits[0].byte_offset > "[[Daily]] ".len() as u64);
    }

    #[test]
    fn match_inside_markdown_link_is_excluded() {
        let src = "[Daily](daily.md) plus Daily standalone\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].byte_offset > "[Daily](daily.md) ".len() as u64 - 1);
    }

    #[test]
    fn unicode_whitespace_acts_as_boundary() {
        let src = "alpha\u{00A0}Daily\u{00A0}omega\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn frontmatter_value_is_not_a_match_source() {
        let src = "---\naliases: [Daily]\n---\nBody Daily here\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
    }
}
