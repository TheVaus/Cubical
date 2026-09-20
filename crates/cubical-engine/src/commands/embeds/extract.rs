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

pub fn extract_section(source: &str, anchor: &str) -> Option<String> {
    let target = slugify(anchor);
    if target.is_empty() {
        return None;
    }
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    let mut matched: Option<(usize, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some((level, text)) = parse_atx_heading(line) {
            if slugify(text) == target {
                matched = Some((i, level));
                break;
            }
        }
    }
    let (start_line, level) = matched?;
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

fn parse_atx_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    Some((hashes, rest.trim_start_matches(' ')))
}

pub fn extract_block(source: &str, byte_offset: u64) -> String {
    let pos = byte_offset as usize;
    if pos >= source.len() {
        return String::new();
    }
    let line_start = source[..pos].rfind('\n').map_or(0, |i| i + 1);
    let mut block_start = line_start;
    loop {
        if block_start == 0 {
            break;
        }
        let prev_end = block_start - 1;
        let prev_start = source[..prev_end].rfind('\n').map_or(0, |i| i + 1);
        let prev_line = &source[prev_start..prev_end];
        if prev_line.trim().is_empty() {
            break;
        }
        block_start = prev_start;
    }
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

pub fn strip_frontmatter(source: &str) -> &str {
    let after_opener = if let Some(rest) = source.strip_prefix("---\n") {
        rest
    } else if let Some(rest) = source.strip_prefix("---\r\n") {
        rest
    } else {
        return source;
    };
    let opener_consumed = source.len() - after_opener.len();
    for (idx, _) in after_opener.match_indices("\n---") {
        let close_start = opener_consumed + idx;
        let after_close_dashes = close_start + "\n---".len();
        if after_close_dashes == source.len() {
            return "";
        }
        let next = &source[after_close_dashes..];
        if let Some(rest) = next.strip_prefix('\n') {
            return rest;
        }
        if let Some(rest) = next.strip_prefix("\r\n") {
            return rest;
        }
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
