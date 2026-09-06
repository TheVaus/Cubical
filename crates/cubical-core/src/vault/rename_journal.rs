use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameJournalEntry {
    pub op_id: i64,
    pub kind: String,
    pub from: String,
    pub to: String,
    pub at: i64,
}

#[must_use]
pub fn serialize_entry(entry: &RenameJournalEntry) -> String {
    serde_json::to_string(entry).expect("RenameJournalEntry serializes")
}

#[must_use]
pub fn parse_entry(line: &str) -> Option<RenameJournalEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

#[must_use]
pub fn parse_all(contents: &str) -> Vec<RenameJournalEntry> {
    contents.lines().filter_map(parse_entry).collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalRead {
    pub entries: Vec<RenameJournalEntry>,
    pub malformed_lines: usize,
}

impl JournalRead {
    #[must_use]
    pub fn is_intact(&self) -> bool {
        self.malformed_lines == 0
    }
}

#[must_use]
pub fn parse_read(contents: &str) -> JournalRead {
    let mut read = JournalRead::default();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match parse_entry(line) {
            Some(entry) => read.entries.push(entry),
            None => read.malformed_lines += 1,
        }
    }
    read
}

#[must_use]
pub fn compact(contents: &str, drop_ops: &HashSet<i64>) -> String {
    let mut out = String::new();
    for entry in parse_all(contents) {
        if drop_ops.contains(&entry.op_id) {
            continue;
        }
        out.push_str(&serialize_entry(&entry));
        out.push('\n');
    }
    out
}

#[must_use]
pub fn journal_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".cubical").join("renames.jsonl")
}

pub fn append_entry(vault_root: &Path, entry: &RenameJournalEntry) -> std::io::Result<()> {
    let path = journal_path(vault_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut line = serialize_entry(entry);
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    f.write_all(line.as_bytes())
}

pub fn read_journal(vault_root: &Path) -> std::io::Result<JournalRead> {
    match std::fs::read_to_string(journal_path(vault_root)) {
        Ok(contents) => Ok(parse_read(&contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(JournalRead::default()),
        Err(e) => Err(e),
    }
}

pub fn rewrite_without(vault_root: &Path, drop_ops: &HashSet<i64>) -> std::io::Result<()> {
    let path = journal_path(vault_root);
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let compacted = compact(&contents, drop_ops);
    if compacted.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    } else {
        super::atomic::atomic_write(&path, compacted.as_bytes())
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(op_id: i64, from: &str, to: &str) -> RenameJournalEntry {
        RenameJournalEntry {
            op_id,
            kind: "file".into(),
            from: from.into(),
            to: to.into(),
            at: 1_750_000_000,
        }
    }

    #[test]
    fn serialize_then_parse_round_trips() {
        let e = entry(7, "notes/Daily.md", "notes/Journal.md");
        let line = serialize_entry(&e);
        assert!(!line.contains('\n'), "a serialized entry is a single line");
        assert_eq!(parse_entry(&line), Some(e));
    }

    #[test]
    fn parse_entry_rejects_blank_and_malformed() {
        assert_eq!(parse_entry(""), None);
        assert_eq!(parse_entry("   "), None);
        assert_eq!(parse_entry("not json"), None);
        assert_eq!(parse_entry("{\"op_id\": 1}"), None);
    }

    #[test]
    fn parse_all_skips_bad_lines_and_preserves_order() {
        let body = format!(
            "{}\n\ngarbage\n{}\n",
            serialize_entry(&entry(1, "a.md", "b.md")),
            serialize_entry(&entry(2, "c.md", "d.md")),
        );
        let got = parse_all(&body);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].op_id, 1);
        assert_eq!(got[1].op_id, 2);
    }

    #[test]
    fn compact_drops_selected_ops_and_malformed_lines() {
        let body = format!(
            "{}\ngarbage\n{}\n{}\n",
            serialize_entry(&entry(1, "a.md", "b.md")),
            serialize_entry(&entry(2, "c.md", "d.md")),
            serialize_entry(&entry(3, "e.md", "f.md")),
        );
        let drop: HashSet<i64> = [2].into_iter().collect();
        let out = compact(&body, &drop);
        let kept = parse_all(&out);
        let ids: Vec<i64> = kept.iter().map(|e| e.op_id).collect();
        assert_eq!(ids, vec![1, 3], "op 2 + the malformed line are gone");
        assert!(
            out.ends_with('\n'),
            "non-empty journal keeps a trailing newline"
        );
    }

    #[test]
    fn compact_empty_result_is_empty_string() {
        let body = format!("{}\n", serialize_entry(&entry(1, "a.md", "b.md")));
        let drop: HashSet<i64> = [1].into_iter().collect();
        assert_eq!(compact(&body, &drop), "");
    }

    #[test]
    fn append_then_read_round_trips_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(read_journal(root).unwrap().entries.is_empty());

        append_entry(root, &entry(1, "a.md", "b.md")).unwrap();
        append_entry(root, &entry(2, "c.md", "d.md")).unwrap();

        let got = read_journal(root).unwrap();
        assert_eq!(got.entries.len(), 2);
        assert_eq!(got.entries[0].op_id, 1);
        assert_eq!(got.entries[1].op_id, 2);
        assert!(got.is_intact());
        assert!(journal_path(root).ends_with(".cubical/renames.jsonl"));
    }

    #[test]
    fn absent_journal_is_an_intact_empty_read() {
        let dir = tempfile::tempdir().unwrap();
        let got = read_journal(dir.path()).expect("absent journal is not an error");
        assert_eq!(got, JournalRead::default());
        assert!(got.is_intact());
    }

    #[test]
    fn unreadable_journal_is_an_error_not_an_empty_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = journal_path(dir.path());
        std::fs::create_dir_all(&path).unwrap();

        let err = read_journal(dir.path()).expect_err("a journal that cannot be read must error");
        assert_ne!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn non_utf8_journal_is_an_error_not_an_empty_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = journal_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x9f]).unwrap();

        assert!(read_journal(dir.path()).is_err());
    }

    #[test]
    fn malformed_lines_are_counted_not_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        append_entry(root, &entry(1, "a.md", "b.md")).unwrap();
        let path = journal_path(root);
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("{\"op_id\": 2, truncated\n");
        std::fs::write(&path, body).unwrap();

        let got = read_journal(root).unwrap();
        assert_eq!(got.entries.len(), 1);
        assert_eq!(got.malformed_lines, 1);
        assert!(!got.is_intact());
    }

    #[test]
    fn blank_lines_do_not_count_as_malformed() {
        let got = parse_read(&format!(
            "\n{}\n\n   \n",
            serialize_entry(&entry(1, "a.md", "b.md"))
        ));
        assert_eq!(got.entries.len(), 1);
        assert!(got.is_intact());
    }

    #[test]
    fn rewrite_without_drops_op_and_keeps_rest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        append_entry(root, &entry(1, "a.md", "b.md")).unwrap();
        append_entry(root, &entry(2, "c.md", "d.md")).unwrap();

        rewrite_without(root, &[1].into_iter().collect()).unwrap();

        let got = read_journal(root).unwrap().entries;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].op_id, 2);
    }

    #[test]
    fn rewrite_without_removes_file_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        append_entry(root, &entry(1, "a.md", "b.md")).unwrap();

        rewrite_without(root, &[1].into_iter().collect()).unwrap();

        assert!(
            !journal_path(root).exists(),
            "empty journal file is removed"
        );
        assert!(read_journal(root).unwrap().entries.is_empty());
    }

    #[test]
    fn rewrite_without_on_missing_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        rewrite_without(dir.path(), &HashSet::new()).unwrap();
    }
}
