//! Status + health DTOs surfaced through IPC.

use serde::{Deserialize, Serialize};

/// High-level state of the search index for the current vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexState {
    /// Initial scan is populating the index. `search` returns whatever
    /// the reader currently sees with `still_indexing: true`.
    Building,
    /// Index is up to date with the last scan/watcher event.
    Ready,
    /// Open or commit failed; further writes are suppressed until next
    /// `search_rebuild_index` or app restart.
    Error,
}

/// Polled by the future UI for "still indexing…" + diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStatus {
    /// Current state.
    pub state: IndexState,
    /// Files indexed so far this session.
    pub indexed_files: u64,
    /// Total file count the scan enumerated (0 until enumeration completes).
    pub total_files: u64,
    /// Unix seconds of the most recent commit, if any.
    pub last_commit_secs: Option<i64>,
}

/// Debug-only health snapshot, for dev console + future settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexHealth {
    /// On-disk schema version stamp.
    pub schema_version: u32,
    /// Tantivy segment count.
    pub segments: u64,
    /// Total document count.
    pub doc_count: u64,
    /// Approximate on-disk bytes.
    pub disk_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_state_serializes_snake_case() {
        let s = serde_json::to_string(&IndexState::Building).unwrap();
        assert_eq!(s, "\"building\"");
        let s = serde_json::to_string(&IndexState::Ready).unwrap();
        assert_eq!(s, "\"ready\"");
        let s = serde_json::to_string(&IndexState::Error).unwrap();
        assert_eq!(s, "\"error\"");
    }
}
