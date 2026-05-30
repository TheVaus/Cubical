//! Pure embed content extractors (L3 Session H.1, spec §9.12). One slice
//! per call — recursion / depth cap / cycle detection live on the
//! frontend in H.2. The handler in `cubical-app::commands::embeds`
//! routes by anchor kind.

/// Lowercase + collapse non-alphanumeric runs to `-` + trim leading/
/// trailing `-`. Used to compare heading text to an anchor value so
/// `"My Section!"` matches anchor `"my-section"` / `"My Section"` /
/// `"My Section!"` — they all slugify to `"my-section"`.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.extend(c.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    trimmed.to_string()
}

/// Slice from the line *after* an ATX heading matching `anchor` (by
/// slug) up to the line *before* the next heading whose level is
/// `≤` the matched heading's. `None` if no heading matches.
pub fn extract_section(source: &str, anchor: &str) -> Option<String> {
    let target = slugify(anchor);
    if target.is_empty() {
        return None;
    }
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    // Find the matched heading.
    let mut matched: Option<(usize, usize)> = None; // (line_index, level)
    for (i, line) in lines.iter().enumerate() {
        if let Some((level, text)) = parse_atx_heading(line) {
            if slugify(text) == target {
                matched = Some((i, level));
                break;
            }
        }
    }
    let (start_line, level) = matched?;
    // Collect from the line AFTER the heading until next heading with level <= matched.
    let mut end_line = lines.len();
    for (j, line) in lines.iter().enumerate().skip(start_line + 1) {
        if let Some((l, _)) = parse_atx_heading(line) {
            if l <= level {
                end_line = j;
                break;
            }
        }
    }
    let slice: String = lines[start_line + 1..end_line].concat();
    Some(slice)
}

/// `(level, text_after_hashes)` if `line` is an ATX heading, else None.
/// Strips the `#`s + the single required space. Trailing `\n` is kept
/// on `text` because callers don't care — they slugify it.
fn parse_atx_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    // CommonMark requires a space (or end of line) after the hashes.
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    Some((hashes, rest.trim_start_matches(' ')))
}

/// Block (paragraph or list-item) containing `byte_offset`: walk to
/// the nearest blank-line boundary on each side. `byte_offset` is the
/// start of a line per `BlockRow::position_hint`'s contract. Returns
/// the contiguous slice as a `String`.
pub fn extract_block(source: &str, byte_offset: u64) -> String {
    let pos = byte_offset as usize;
    if pos >= source.len() {
        return String::new();
    }
    // Find the start of the line containing `pos`.
    let line_start = source[..pos].rfind('\n').map_or(0, |i| i + 1);
    // Walk back over preceding non-blank lines.
    let mut block_start = line_start;
    loop {
        if block_start == 0 {
            break;
        }
        // The previous line ends at block_start - 1 (the '\n'); its
        // start is the byte after the previous '\n' before that.
        let prev_end = block_start - 1; // index of the '\n'
        let prev_start = source[..prev_end].rfind('\n').map_or(0, |i| i + 1);
        let prev_line = &source[prev_start..prev_end];
        if prev_line.trim().is_empty() {
            break;
        }
        block_start = prev_start;
    }
    // Walk forward over the line containing `pos` and following non-blank lines.
    let mut block_end = line_start;
    while block_end < source.len() {
        let line_end_excl = source[block_end..]
            .find('\n')
            .map_or(source.len(), |i| block_end + i + 1);
        let line = &source[block_end..line_end_excl];
        let line_text = line.trim_end_matches(['\r', '\n']);
        if line_text.trim().is_empty() {
            break;
        }
        block_end = line_end_excl;
    }
    source[block_start..block_end].to_string()
}

/// If `source` opens with a YAML frontmatter block (`---\n…\n---\n`),
/// return the body slice after the closer. Otherwise return `source`
/// unchanged. Pure, borrow-returning.
pub fn strip_frontmatter(source: &str) -> &str {
    // Accept "---\n" or "---\r\n" as the opener; require a closing
    // "---" on its own line. Anything else → return source unchanged.
    let after_opener = if let Some(rest) = source.strip_prefix("---\n") {
        rest
    } else if let Some(rest) = source.strip_prefix("---\r\n") {
        rest
    } else {
        return source;
    };
    // Find the closing "---" line. Match on "\n---\n", "\n---\r\n",
    // or "\n---" at the very end of file.
    let opener_consumed = source.len() - after_opener.len();
    for (idx, _) in after_opener.match_indices("\n---") {
        let close_start = opener_consumed + idx; // index of the '\n' before "---"
        let after_close_dashes = close_start + "\n---".len();
        if after_close_dashes == source.len() {
            // Closer is the last 3 chars; body is empty.
            return "";
        }
        let next = &source[after_close_dashes..];
        if let Some(rest) = next.strip_prefix('\n') {
            return rest;
        }
        if let Some(rest) = next.strip_prefix("\r\n") {
            return rest;
        }
        // "---" mid-line, not a closer — keep looking.
    }
    source
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_collapses_and_lowercases() {
        assert_eq!(slugify("My Section!"), "my-section");
        assert_eq!(slugify("My Section"), "my-section");
        assert_eq!(slugify("my-section"), "my-section");
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn extract_section_matches_heading_by_slug() {
        let src = "# My Section\nbody\n";
        assert_eq!(extract_section(src, "my-section"), Some("body\n".into()));
    }

    #[test]
    fn extract_section_respects_level_ceiling() {
        let src = "## A\nfoo\n# B\nbar\n";
        // anchor "a" matches "## A" (level 2); stops at "# B" (level 1 ≤ 2).
        assert_eq!(extract_section(src, "a"), Some("foo\n".into()));
    }

    #[test]
    fn extract_section_keeps_subheadings_below_the_matched_level() {
        let src = "# A\nfoo\n## A.1\nbar\n# B\n";
        assert_eq!(extract_section(src, "a"), Some("foo\n## A.1\nbar\n".into()),);
    }

    #[test]
    fn extract_section_returns_none_when_missing() {
        assert_eq!(extract_section("# A\nfoo\n", "ghost"), None);
    }

    #[test]
    fn extract_block_paragraph_walks_to_blank_lines() {
        let src = "para one\nstill para ^id\n\nnext\n";
        let offset = src.find("still para").unwrap() as u64;
        assert_eq!(extract_block(src, offset), "para one\nstill para ^id\n");
    }

    #[test]
    fn extract_block_list_item_block_ends_at_blank_line() {
        let src = "- a\n- b ^id\n- c\n\nafter\n";
        let offset = src.find("- b ^id").unwrap() as u64;
        assert_eq!(extract_block(src, offset), "- a\n- b ^id\n- c\n");
    }

    #[test]
    fn extract_block_returns_empty_when_offset_past_end() {
        assert_eq!(extract_block("short\n", 999), String::new());
    }

    #[test]
    fn strip_frontmatter_present_returns_body() {
        assert_eq!(strip_frontmatter("---\ntitle: x\n---\nbody\n"), "body\n",);
    }

    #[test]
    fn strip_frontmatter_absent_returns_full_source() {
        assert_eq!(strip_frontmatter("plain\n"), "plain\n");
    }

    #[test]
    fn strip_frontmatter_unclosed_returns_full_source() {
        assert_eq!(
            strip_frontmatter("---\nonly opener\n"),
            "---\nonly opener\n"
        );
    }
}
