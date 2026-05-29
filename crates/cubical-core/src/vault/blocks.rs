//! Block-id source scanning + per-file index refresh (L3 Session G,
//! spec §2.7). A block id is `^id` (`^` + `[A-Za-z_][A-Za-z0-9_-]*`) at
//! the end of a source line, ignored inside fenced code. Ids are read
//! here but only ever *minted* by `create_block_ref` — never bulk
//! auto-assigned (spec §2.7 / document-model §5.3).

/// One `^block-id` occurrence found in a file's source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockIdOccurrence {
    /// The id without the leading `^`.
    pub block_id: String,
    /// Byte offset of the start of the line carrying the id.
    pub position: u64,
}

/// Scan markdown `source` for `^block-id` tokens at line ends, skipping
/// fenced code blocks. Returns occurrences in source order. Pure.
pub fn extract_block_ids(source: &str) -> Vec<BlockIdOccurrence> {
    let mut out = Vec::new();
    let mut offset: u64 = 0;
    let mut in_fence = false;
    let mut fence_marker = "";
    for line in source.split_inclusive('\n') {
        let trimmed_end = line.trim_end_matches(['\n', '\r']);
        let trimmed = trimmed_end.trim();
        // Track fenced code so ids inside it don't count.
        if !in_fence && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            in_fence = true;
            fence_marker = if trimmed.starts_with("```") {
                "```"
            } else {
                "~~~"
            };
        } else if in_fence && trimmed.starts_with(fence_marker) {
            in_fence = false;
        } else if !in_fence {
            if let Some(id) = block_id_at_line_end(trimmed_end) {
                out.push(BlockIdOccurrence {
                    block_id: id,
                    position: offset,
                });
            }
        }
        offset += line.len() as u64;
    }
    out
}

/// If `line` (trailing newline already stripped) ends with a block id
/// token (`^id` either preceded by whitespace or as the whole trimmed
/// line), return the id without the `^`. Otherwise `None`.
fn block_id_at_line_end(line: &str) -> Option<String> {
    let line = line.trim_end();
    let caret = line.rfind('^')?;
    let id = &line[caret + 1..];
    // The `^` must start the (trimmed) line or follow whitespace.
    let before_ok = caret == 0
        || line[..caret]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
    if !before_ok {
        return None;
    }
    if !is_valid_block_id(id) {
        return None;
    }
    Some(id.to_string())
}

/// `[A-Za-z_][A-Za-z0-9_-]*` — must start letter/underscore.
fn is_valid_block_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_trailing_block_id() {
        let src = "A paragraph line. ^intro\n\nnext para\n";
        let got = extract_block_ids(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].block_id, "intro");
        assert_eq!(got[0].position, 0);
    }

    #[test]
    fn extracts_id_on_its_own_line_with_position() {
        // Line 0 is "para" (5 bytes incl. \n), line 1 is "^solo".
        let src = "para\n^solo\n";
        let got = extract_block_ids(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].block_id, "solo");
        assert_eq!(got[0].position, 5);
    }

    #[test]
    fn ignores_block_ids_inside_fenced_code() {
        let src = "```\nlet x = 1; ^notanid\n```\n\nreal ^yes\n";
        let got = extract_block_ids(src);
        let ids: Vec<&str> = got.iter().map(|o| o.block_id.as_str()).collect();
        assert_eq!(ids, vec!["yes"]);
    }

    #[test]
    fn rejects_mid_line_and_invalid_starts() {
        // `^id` not at end of line → not a block id.
        assert!(extract_block_ids("text ^mid more\n").is_empty());
        // Caret followed by a digit-start → invalid (must start letter/_).
        assert!(extract_block_ids("text ^1bad\n").is_empty());
        // Bare caret → nothing.
        assert!(extract_block_ids("text ^\n").is_empty());
    }

    #[test]
    fn empty_source_returns_empty() {
        assert!(extract_block_ids("").is_empty());
    }
}
