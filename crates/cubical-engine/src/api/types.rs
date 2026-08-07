use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    InProgress,
    Complete,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpenVaultRequest {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenVaultResponse {
    pub vault_id: String,
    pub scan_status: ScanStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CancelVaultScanRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetVaultInfoRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetVaultInfoResponse {
    pub path: PathBuf,
    pub file_count: u32,
    pub markdown_count: u32,
    pub binary_count: u32,
    pub schema_version: u32,
    pub scan_status: ScanStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListFilesRequest {
    pub vault_id: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListFilesResponse {
    pub files: Vec<FileEntry>,
    pub total: u32,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateFileRequest {
    pub vault_id: String,
    #[serde(default)]
    pub parent_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateFileResponse {
    pub path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateFileAtPathRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateFileAtPathResponse {
    pub path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateFolderRequest {
    pub vault_id: String,
    #[serde(default)]
    pub parent_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateFolderResponse {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeletePathRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub type_id: String,
    pub size_bytes: u64,
    pub mtime_unix: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetFrontmatterRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetFrontmatterResponse {
    pub entries: Vec<FrontmatterEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontmatterEntry {
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReadFileTextRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadFileTextResponse {
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReadFileBytesRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadFileBytesResponse {
    pub base64: String,
    pub mime: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetCanonicalAstRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetCanonicalAstResponse {
    pub document: cubical_ast::Document,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WriteFileTextRequest {
    pub vault_id: String,
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub expected_seen_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteFileTextResponse {
    pub new_content_hash: String,
    pub new_mtime_unix: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetSettingRequest {
    pub vault_id: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetSettingResponse {
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetSettingRequest {
    pub vault_id: String,
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetSettingResponse {}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolveLinkRequest {
    pub vault_id: String,
    pub target_raw: String,
    #[serde(default)]
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolveLinkResponse {
    pub target_path: Option<String>,
    pub anchor: Option<ResolvedAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedAnchor {
    Heading { value: String },
    Block { value: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetBacklinksRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetBacklinksResponse {
    pub backlinks: Vec<Backlink>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Backlink {
    pub source_path: String,
    pub context: String,
    pub position: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueryTagPageRequest {
    pub vault_id: String,
    pub tag_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryTagPageResponse {
    pub files: Vec<TagPageFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagPageFile {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LinkAutocompleteRequest {
    pub vault_id: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkAutocompleteResponse {
    pub candidates: Vec<LinkCandidate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkCandidate {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TagAutocompleteRequest {
    pub vault_id: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagAutocompleteResponse {
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListTagsRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListTagsResponse {
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloseVaultRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateBlockRefRequest {
    pub vault_id: String,
    pub target_path: String,
    pub position: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateBlockRefResponse {
    pub block_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetBrokenBlockRefsRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetBrokenBlockRefsResponse {
    pub refs: Vec<BrokenBlockRefDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrokenBlockRefDto {
    pub source_file_path: String,
    pub target_file_path: String,
    pub target_block_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlockIdAutocompleteRequest {
    pub vault_id: String,
    pub target_raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockIdAutocompleteResponse {
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetEmbedRequest {
    pub vault_id: String,
    pub target_raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmbedKind {
    Note,
    Section,
    Block,
    Unresolved,
    MissingAnchor,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetEmbedResponse {
    pub kind: EmbedKind,
    pub target_path: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetPropertyRequest {
    pub vault_id: String,
    pub note_raw: String,
    pub property: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyRefKind {
    Resolved,
    NoteUnresolved,
    PropertyMissing,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetPropertyResponse {
    pub kind: PropertyRefKind,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetUnlinkedMentionsRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetUnlinkedMentionsResponse {
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Mention {
    pub source_path: String,
    pub context: String,
    pub position: u64,
    pub byte_len: u64,
    pub needle: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LinkMentionRequest {
    pub vault_id: String,
    pub source_path: String,
    pub position: u64,
    pub byte_len: u64,
    pub target_title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkMentionResponse {
    pub new_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameFileRequest {
    pub vault_id: String,
    pub from_path: String,
    pub to_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenameFileResponse {
    pub rename_op_id: i64,
    pub pending_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameFolderRequest {
    pub vault_id: String,
    pub from_path: String,
    pub to_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenameFolderResponse {
    pub rename_op_id: i64,
    pub pending_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameTagRequest {
    pub vault_id: String,
    pub old_tag: String,
    pub new_tag: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenameTagResponse {
    pub rename_op_id: i64,
    pub pending_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameBlockIdRequest {
    pub vault_id: String,
    pub file_path: String,
    pub old_id: String,
    pub new_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenameBlockIdResponse {
    pub rename_op_id: i64,
    pub pending_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FlushPendingRewritesRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FlushPendingRewritesForTargetRequest {
    pub vault_id: String,
    pub target_file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlushPendingRewritesResponse {
    pub files_rewritten: i64,
    pub refs_updated: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetPendingRewritesCountRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetPendingRewritesCountResponse {
    pub count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetPendingRewritesBreakdownRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingRewriteBreakdownRow {
    pub target_file: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetPendingRewritesBreakdownResponse {
    pub rows: Vec<PendingRewriteBreakdownRow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListRecentRenameOpsRequest {
    pub vault_id: String,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentRenameOp {
    pub rename_op_id: i64,
    pub kind: String,
    pub row_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListRecentRenameOpsResponse {
    pub ops: Vec<RecentRenameOp>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UndoRenameRequest {
    pub vault_id: String,
    pub rename_op_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UndoRenameResponse {
    pub removed: u64,
    pub pending_count: i64,
}

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

pub use cubical_search::{
    FieldScope as SearchFieldScope, IndexHealth as SearchHealthDto, IndexState as SearchIndexState,
    IndexStatus as SearchIndexStatusDto, MatchedField as SearchMatchedField, SearchHit,
    SearchQuery, SearchResponse, SortMode as SearchSortMode,
};

#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub vault_id: String,
    pub query: SearchQuery,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchVaultRequest {
    pub vault_id: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct ReloadSettingsRequest {
    pub vault_id: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ReloadSettingsResponse {
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DataviewQueryRequest {
    pub vault_id: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DataviewResult {
    List {
        notes: Vec<cubical_query::NoteRef>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<cubical_query::Row>,
    },
    Count {
        count: usize,
    },
    Error {
        message: String,
    },
}

impl From<cubical_query::QueryResult> for DataviewResult {
    fn from(r: cubical_query::QueryResult) -> Self {
        match r {
            cubical_query::QueryResult::List { notes } => Self::List { notes },
            cubical_query::QueryResult::Table { columns, rows } => Self::Table { columns, rows },
            cubical_query::QueryResult::Count { count } => Self::Count { count },
        }
    }
}
