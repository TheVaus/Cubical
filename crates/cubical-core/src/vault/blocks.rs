//! Block-id source scanning + per-file index refresh (L3 Session G,
//! spec §2.7). A block id is `^id` (`^` + `[A-Za-z_][A-Za-z0-9_-]*`) at
//! the end of a source line, ignored inside fenced code. Ids are read
//! here but only ever *minted* by `create_block_ref` — never bulk
//! auto-assigned (spec §2.7 / document-model §5.3).

use cubical_index::{replace_block_refs_for_file, replace_blocks_for_file, BlockRefRow, BlockRow};

use crate::vault::links::map_index_err;
use crate::vault::Vault;

/// Scan `source` for `^block-id` tokens and replace this file's
/// `blocks` rows. The matching `files` row must already exist (FK).
///
/// **L3 Session J (chain 3):** caller passes the post-`materialize_on_read`
/// source so block-ids reflect any pending block-id rewrites before they
/// flush. Read + materialize happen once at the caller; this helper is
/// the pure-scan + DB write step.
pub async fn refresh_blocks(
    vault: &Vault,
    rel_path_str: &str,
    source: &str,
) -> Result<(), libsql::Error> {
    let rows: Vec<BlockRow> = extract_block_ids(source)
        .into_iter()
        .map(|o| BlockRow {
            block_id: o.block_id,
            position_hint: o.position,
        })
        .collect();
    replace_blocks_for_file(vault.index(), rel_path_str, &rows)
        .await
        .map_err(map_index_err)
}

/// Derive this file's `block_refs` from its resolved block-anchored
/// rows in the `links` table (`anchor_kind='block'` with a non-null
/// `target_path`) and replace them. Used by both the scan (Pass 2,
/// after links are written) and the watcher.
pub async fn refresh_block_refs_for_file(
    vault: &Vault,
    source_path: &str,
) -> Result<(), libsql::Error> {
    let conn = vault.index().connection();
    let mut rows = conn
        .query(
            "SELECT target_path, anchor_value FROM links \
             WHERE source_path = ?1 AND anchor_kind = 'block' AND target_path IS NOT NULL \
               AND anchor_value IS NOT NULL",
            libsql::params![source_path],
        )
        .await?;
    let mut refs = Vec::new();
    while let Some(row) = rows.next().await? {
        let target_file_path: String = row.get(0)?;
        let target_block_id: String = row.get(1)?;
        refs.push(BlockRefRow {
            target_file_path,
            target_block_id,
        });
    }
    replace_block_refs_for_file(vault.index(), source_path, &refs)
        .await
        .map_err(map_index_err)
}

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

    #[tokio::test]
    async fn refresh_blocks_populates_rows_from_source() {
        use cubical_index::blocks_for_file;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        std::fs::write(&p, "first para ^one\n\nsecond ^two\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        // The files row must exist for the FK; a scan creates it.
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        crate::vault::scan(
            vault.clone(),
            tokio_util::sync::CancellationToken::new(),
            tx,
        )
        .await
        .expect("scan");

        let src = std::fs::read_to_string(&p).unwrap();
        refresh_blocks(&vault, "a.md", &src).await.expect("refresh");
        let got = blocks_for_file(vault.index(), "a.md").await.unwrap();
        let ids: Vec<&str> = got.iter().map(|b| b.block_id.as_str()).collect();
        assert_eq!(ids, vec!["one", "two"]);
    }

    #[tokio::test]
    async fn refresh_block_refs_derives_from_resolved_block_links() {
        use cubical_index::broken_block_refs;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("src.md"),
            "see [[tgt#^present]] and [[tgt#^gone]]\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("tgt.md"), "body ^present\n").unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        crate::vault::scan(
            vault.clone(),
            tokio_util::sync::CancellationToken::new(),
            tx,
        )
        .await
        .expect("scan");

        // After a full scan, "gone" has no blocks row → exactly one broken ref.
        let broken = broken_block_refs(vault.index()).await.unwrap();
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].source_file_path, "src.md");
        assert_eq!(broken[0].target_block_id, "gone");
    }
}
