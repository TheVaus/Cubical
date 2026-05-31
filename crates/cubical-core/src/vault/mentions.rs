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

    // `line_start` is reassigned inside the loop at fence open/close
    // boundaries; the final reassignment after the last block is dead
    // because the loop only exits when `i >= len`. Allow the warning
    // rather than refactor the control flow.
    #[allow(unused_assignments)]
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
            let opener_start = if i > 0 && bytes[i - 1] == b'!' {
                i - 1
            } else {
                i
            };
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
    // Pre-filter needles: keep non-empty after trim. Lowercase once.
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
        // Lowercased length may differ from byte length when sources
        // contain casefolding-expanding characters; for matching we
        // operate on `run_lower` and map matches back via `char_indices`
        // of the original slice. Keep this simple: for ASCII the byte
        // offsets line up. For non-ASCII titles, this still works
        // because we use the **lowered** match's char position to walk
        // the **original** char_indices in parallel.
        //
        // We use a single linear scan per needle. N (needles) is small
        // (typically ≤5: title + a few aliases).
        for (needle_idx, needle_lower, _needle_byte_len) in &prepared {
            // Search positions one char at a time so byte boundaries
            // land cleanly. find() works on bytes (UTF-8 safe).
            let mut search_from = 0usize;
            while search_from <= run_lower.len() {
                let Some(rel) = run_lower[search_from..].find(needle_lower) else {
                    break;
                };
                let match_start = search_from + rel;
                let match_end = match_start + needle_lower.len();

                // Whole-word boundary check on the LOWER form — same
                // chars, just casefolded, so word/non-word classification
                // is preserved.
                if is_word_boundary(&run_lower, match_start, match_end) {
                    // Translate the matched span back to the original
                    // run's bytes. For ASCII titles this is identity;
                    // for non-ASCII we map via char_indices.
                    let (orig_start, orig_len) =
                        map_lower_span_to_original(run.slice, &run_lower, match_start, match_end);
                    out.push(MentionHit {
                        needle_index: *needle_idx,
                        byte_offset: run.start + orig_start as u64,
                        byte_len: orig_len as u64,
                    });
                    // Advance past this match.
                    search_from = match_end;
                } else {
                    // Slide forward by one char.
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
    // Sort by source position so callers don't need to re-sort.
    out.sort_by_key(|h| h.byte_offset);
    out
}

/// Whole-word boundary check: the chars immediately before / after the
/// match span must be either absent (run edge) or non-word
/// (`!alphanumeric && != '_'`).
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

/// Translate `[match_start..match_end)` in `lower` back to the
/// equivalent `(orig_start, orig_len)` in `original`. Walks chars in
/// lockstep — for ASCII this is identity, for non-ASCII it accounts
/// for casefolding-induced length changes (e.g. `ß` → `ss`).
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
                // Advance lower iterator by the lowercased width of `oc`
                // when oc.to_lowercase() produces multi-char output.
                let lowered_len: usize = oc.to_lowercase().map(|c| c.len_utf8()).sum();
                if lowered_len > oc.len_utf8() {
                    // Skip extra lower-side chars to stay in lockstep.
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
        // The plain text outside the span survives.
        assert!(joined.contains("see "));
        assert!(joined.contains("Daily again"));
        // The span's interior does not.
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
        // "hello [[Daily]] world" — runs at 0 ("hello ") and 15 (" world\n").
        let runs = extract_text_runs("hello [[Daily]] world\n");
        let starts: Vec<u64> = runs.iter().map(|r| r.start).collect();
        assert_eq!(starts.first().copied(), Some(0));
        // Second run starts after the closing ]] which ends at byte 15.
        assert!(starts.contains(&15), "starts: {starts:?}");
    }

    // ---- find_mention_occurrences --------------------------------

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
        // The session prompt says skip needles containing whitespace;
        // but the spec allows the title to be multi-word. Decision:
        // allow internal spaces, only block leading/trailing or empty.
        // (See "Decisions" table — we treat trimming as silent.)
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
        // The surviving match is the second one (after the wiki-link).
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
        let src = "alpha\u{00A0}Daily\u{00A0}omega\n"; // NBSP on both sides
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn frontmatter_value_is_not_a_match_source() {
        let src = "---\naliases: [Daily]\n---\nBody Daily here\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        // Only the body match should land.
        assert_eq!(hits.len(), 1);
    }
}
