use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexState {
    Building,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStatus {
    pub state: IndexState,
    pub indexed_files: u64,
    pub total_files: u64,
    pub last_commit_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexHealth {
    pub schema_version: u32,
    pub segments: u64,
    pub doc_count: u64,
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
