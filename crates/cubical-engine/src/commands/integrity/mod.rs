#[cfg(test)]
mod fixtures;
mod query;
mod repair;

pub use query::list_dangling_links;
pub use repair::repair_dangling_link;

use serde::{Deserialize, Serialize};

pub(crate) const DANGLING_PREDICATE: &str =
    "(target_path IS NULL OR target_path NOT IN (SELECT path FROM files))";

#[derive(Debug, Clone, Deserialize)]
pub struct ListDanglingLinksRequest {
    pub vault_id: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DanglingLinkOccurrence {
    pub source_path: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepairCandidate {
    pub path: String,
    pub rank: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DanglingLinkGroup {
    pub target_raw: String,
    pub missing_path: Option<String>,
    pub total: i64,
    pub occurrences: Vec<DanglingLinkOccurrence>,
    pub candidates: Vec<RepairCandidate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListDanglingLinksResponse {
    pub groups: Vec<DanglingLinkGroup>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RepairDanglingLinkRequest {
    pub vault_id: String,
    pub target_raw: String,
    pub to_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepairDanglingLinkResponse {
    pub files_rewritten: i64,
    pub refs_updated: i64,
    pub pending_count: i64,
}
