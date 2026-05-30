//! Request and response types for IPC commands.
//!
//! Plain `serde` structs — no Tauri imports, no Tauri-specific decorators.
//! These cross the Lane 1 ↔ Lane 2 boundary and survive a future shell
//! migration unchanged.
//!
//! See `docs/layer-0-spec.md` §8.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Status of a vault's initial scan at the moment a command observed it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    /// The scan task is still running.
    InProgress,
    /// The scan task has finished — `files` reflects the full vault contents.
    Complete,
    /// The scan was cancelled before finishing.
    Cancelled,
}

// -- open_vault ----------------------------------------------------------

/// Request payload for `open_vault`.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenVaultRequest {
    /// Absolute path to the directory the user picked.
    pub path: PathBuf,
}

/// Response payload for `open_vault`.
#[derive(Debug, Clone, Serialize)]
pub struct OpenVaultResponse {
    /// Session-scoped handle the frontend uses to refer to this vault.
    pub vault_id: String,
    /// Status of the initial scan at the moment the response was built.
    pub scan_status: ScanStatus,
}

// -- cancel_vault_scan ---------------------------------------------------

/// Request payload for `cancel_vault_scan`.
#[derive(Debug, Clone, Deserialize)]
pub struct CancelVaultScanRequest {
    /// Vault whose scan should be cancelled.
    pub vault_id: String,
}

// -- get_vault_info ------------------------------------------------------

/// Request payload for `get_vault_info`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetVaultInfoRequest {
    /// Vault to query.
    pub vault_id: String,
}

/// Response payload for `get_vault_info`.
#[derive(Debug, Clone, Serialize)]
pub struct GetVaultInfoResponse {
    /// Absolute path the vault was opened against.
    pub path: PathBuf,
    /// Number of files currently tracked in the index. Reflects what the
    /// scan has discovered so far if the scan is still running.
    pub file_count: u32,
    /// Subset of `file_count` with `type_id = "markdown"`.
    pub markdown_count: u32,
    /// Subset of `file_count` with `type_id = "binary"`.
    pub binary_count: u32,
    /// Schema version on disk.
    pub schema_version: u32,
    /// Status of the initial scan at the moment the query was answered.
    pub scan_status: ScanStatus,
}

// -- list_files ----------------------------------------------------------

/// Request payload for `list_files`.
#[derive(Debug, Clone, Deserialize)]
pub struct ListFilesRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Optional pagination cap — defaults to `u32::MAX` (return everything).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Optional pagination offset — defaults to 0.
    #[serde(default)]
    pub offset: Option<u32>,
}

/// Response payload for `list_files`.
#[derive(Debug, Clone, Serialize)]
pub struct ListFilesResponse {
    /// Files discovered so far. May be a partial view if the scan is still in progress.
    pub files: Vec<FileEntry>,
    /// Total count of files in the index (independent of `limit`/`offset`).
    pub total: u32,
}

/// Per-file row returned by `list_files`.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    /// Path relative to the vault root.
    pub path: String,
    /// Stable file-type handler id (`"markdown"`, `"binary"`, ...).
    pub type_id: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Unix mtime in seconds.
    pub mtime_unix: i64,
}

// -- get_frontmatter ------------------------------------------------------

/// Request payload for `get_frontmatter`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetFrontmatterRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Path of the file (relative to the vault root, as stored in
    /// `files.path`).
    pub path: String,
}

/// Response payload for `get_frontmatter`.
#[derive(Debug, Clone, Serialize)]
pub struct GetFrontmatterResponse {
    /// Parsed frontmatter entries in stored order. Empty list means
    /// the file exists in the index but has no frontmatter (or its
    /// frontmatter was malformed and was logged but not indexed).
    pub entries: Vec<FrontmatterEntry>,
}

/// One frontmatter key/value pair.
///
/// `value` is `serde_json::Value` so callers handle scalars, lists,
/// and nested objects with the same wire shape.
#[derive(Debug, Clone, Serialize)]
pub struct FrontmatterEntry {
    /// YAML key as written in the source.
    pub key: String,
    /// JSON-shaped value parsed from YAML.
    pub value: serde_json::Value,
}

// -- read_file_text ------------------------------------------------------

/// Request payload for `read_file_text`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReadFileTextRequest {
    /// Vault to read from.
    pub vault_id: String,
    /// Path of the file (relative to the vault root, as stored in
    /// `files.path`).
    pub path: String,
}

/// Response payload for `read_file_text`.
#[derive(Debug, Clone, Serialize)]
pub struct ReadFileTextResponse {
    /// File contents as a UTF-8 string. Only markdown files are
    /// readable through this command — binary files are rejected
    /// with [`crate::error::CubicalError::InvalidRequest`].
    pub content: String,
}

// -- get_canonical_ast ---------------------------------------------------

/// Request payload for `get_canonical_ast`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetCanonicalAstRequest {
    /// Vault to read from.
    pub vault_id: String,
    /// Path of the file (relative to the vault root, as stored in
    /// `files.path`).
    pub path: String,
}

/// Response payload for `get_canonical_ast`.
///
/// The wire shape of `document` is the canonical AST defined in
/// `cubical_ast`. The frontend's TS mirrors must stay in lockstep —
/// see `ui/src/ast/types.ts`.
#[derive(Debug, Clone, Serialize)]
pub struct GetCanonicalAstResponse {
    /// Parsed canonical document. Always reflects on-disk source —
    /// nothing is cached between calls.
    pub document: cubical_ast::Document,
}

// -- write_file_text -----------------------------------------------------

/// Request payload for `write_file_text`.
///
/// `expected_seen_hash` is advisory in L2 (see `docs/layer-2-spec.md`
/// §3.1): if `Some` and it doesn't match the on-disk hash at write
/// time, the handler still proceeds (preserving the user's "Keep my
/// edits" choice from §2.7) but writes an `external_edit_override`
/// audit_log row at level `warn`. Hard rejection is deferred to L8
/// when the merge UI exists.
#[derive(Debug, Clone, Deserialize)]
pub struct WriteFileTextRequest {
    /// Vault to write into.
    pub vault_id: String,
    /// Path of the file (relative to the vault root, as stored in
    /// `files.path`). Must already exist with `type_id = "markdown"`.
    pub path: String,
    /// New UTF-8 contents to write.
    pub content: String,
    /// Hash the editor *thought* the file had on disk when the user's
    /// edits diverged from baseline. Advisory in L2.
    #[serde(default)]
    pub expected_seen_hash: Option<String>,
}

/// Response payload for `write_file_text`.
#[derive(Debug, Clone, Serialize)]
pub struct WriteFileTextResponse {
    /// SHA-256 of the bytes just written (lowercase hex). The editor
    /// stashes this as its `last_written_hash` so the round-trip
    /// `vault:file-changed` event can be hash-gated away (§2.8).
    pub new_content_hash: String,
    /// Unix seconds of the file's mtime after the write.
    pub new_mtime_unix: i64,
}

// -- get_setting ---------------------------------------------------------

/// Request payload for `get_setting`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetSettingRequest {
    /// Vault whose `config` table to read.
    pub vault_id: String,
    /// Setting key (e.g. `editor.raw_source_default`).
    pub key: String,
}

/// Response payload for `get_setting`.
#[derive(Debug, Clone, Serialize)]
pub struct GetSettingResponse {
    /// Decoded JSON value, or `None` when the key is absent from the
    /// `config` table. A stored JSON `null` is `Some(Value::Null)` —
    /// distinct from a missing key.
    pub value: Option<serde_json::Value>,
}

// -- set_setting ---------------------------------------------------------

/// Request payload for `set_setting`.
#[derive(Debug, Clone, Deserialize)]
pub struct SetSettingRequest {
    /// Vault whose `config` table to write.
    pub vault_id: String,
    /// Setting key (e.g. `appearance.theme_mode`).
    pub key: String,
    /// Value to store. JSON-encoded on the way in so non-string types
    /// round-trip cleanly.
    pub value: serde_json::Value,
}

/// Response payload for `set_setting`. Empty — the upsert either
/// succeeds or returns an error.
#[derive(Debug, Clone, Serialize)]
pub struct SetSettingResponse {}

// -- resolve_link --------------------------------------------------------

/// Request payload for `resolve_link`.
#[derive(Debug, Clone, Deserialize)]
pub struct ResolveLinkRequest {
    /// Vault whose link index + files table to resolve against.
    pub vault_id: String,
    /// The wiki-link target as written. Accepts the post-tokenizer
    /// shape (e.g. `note`, `note#heading`, `note#^id`) — the leading
    /// `[[` and trailing `]]` are stripped by the AST, and `!` (embed)
    /// has already been split off.
    pub target_raw: String,
    /// Reserved for future relative resolution. Ignored in L3 Session A.
    #[serde(default)]
    pub source_path: Option<String>,
}

/// Response payload for `resolve_link`.
#[derive(Debug, Clone, Serialize)]
pub struct ResolveLinkResponse {
    /// Resolved vault-relative path, or `None` when no unique match
    /// exists (missing, ambiguous, or empty target).
    pub target_path: Option<String>,
    /// Parsed anchor if the target carried one. Heading / block kind
    /// is preserved so the frontend can scroll to the right spot.
    pub anchor: Option<ResolvedAnchor>,
}

/// IPC-shape mirror of `cubical_ast::Anchor`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedAnchor {
    /// `[[note#heading]]` — anchor by heading text.
    Heading {
        /// Heading text after `#`, trimmed.
        value: String,
    },
    /// `[[note#^id]]` — anchor by block id.
    Block {
        /// Block id after `#^`, trimmed.
        value: String,
    },
}

// -- get_backlinks -------------------------------------------------------

/// Request payload for `get_backlinks`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetBacklinksRequest {
    /// Vault whose link index to query.
    pub vault_id: String,
    /// Vault-relative path of the note whose backlinks to list. The
    /// handler matches `links.target_path` against this string.
    pub path: String,
}

/// Response payload for `get_backlinks`.
#[derive(Debug, Clone, Serialize)]
pub struct GetBacklinksResponse {
    /// Backlinks in `(source_path, position)` order. Empty when no
    /// note links at `path`.
    pub backlinks: Vec<Backlink>,
}

/// One backlink row surfaced to the frontend.
///
/// `context` is a single-line snippet (~120 chars) drawn from the
/// source file's text around `position`. Empty only when the
/// enclosing block has no readable text.
#[derive(Debug, Clone, Serialize)]
pub struct Backlink {
    /// Vault-relative path of the source note that links here.
    pub source_path: String,
    /// Single-line context snippet, ~120 chars centred on `position`.
    pub context: String,
    /// Byte offset of the link's opener within `source_path`. Used by
    /// the frontend as a stable key/sort tiebreaker.
    pub position: u64,
}

// -- query_tag_page ------------------------------------------------------

/// Request payload for `query_tag_page`.
#[derive(Debug, Clone, Deserialize)]
pub struct QueryTagPageRequest {
    /// Vault whose tag index to query.
    pub vault_id: String,
    /// Tag path without the leading `#`. Matched case-insensitively
    /// against `tags.tag_path`; the response includes every file whose
    /// tag equals this path or descends from it (`tag/child`).
    pub tag_path: String,
}

/// Response payload for `query_tag_page`.
#[derive(Debug, Clone, Serialize)]
pub struct QueryTagPageResponse {
    /// One row per file carrying the tag (or any descendant). Ordered
    /// by `path` for stable rendering; empty when no file matches.
    pub files: Vec<TagPageFile>,
}

/// One file row in a virtual tag page.
#[derive(Debug, Clone, Serialize)]
pub struct TagPageFile {
    /// Vault-relative path to the file.
    pub path: String,
    /// Display title — the basename minus the `.md` extension. Falls
    /// back to the full path when the basename can't be derived (e.g.
    /// an unusual path with no segment).
    pub title: String,
}

// -- link_autocomplete / tag_autocomplete (L3 Session F) -----------------

/// Request payload for `link_autocomplete`.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkAutocompleteRequest {
    /// Vault whose file index to query.
    pub vault_id: String,
    /// Substring typed after `[[`. Empty means "list the first page".
    pub query: String,
}

/// Response payload for `link_autocomplete`.
#[derive(Debug, Clone, Serialize)]
pub struct LinkAutocompleteResponse {
    /// Candidate files, ordered by path, capped server-side.
    pub candidates: Vec<LinkCandidate>,
}

/// One link-autocomplete candidate.
#[derive(Debug, Clone, Serialize)]
pub struct LinkCandidate {
    /// Vault-relative path — inserted as the wiki-link target.
    pub path: String,
    /// Display title — basename minus `.md`. Shown as the dropdown label.
    pub title: String,
}

/// Request payload for `tag_autocomplete`.
#[derive(Debug, Clone, Deserialize)]
pub struct TagAutocompleteRequest {
    /// Vault whose tag index to query.
    pub vault_id: String,
    /// Prefix typed after `#`. Empty means "list the first page".
    pub query: String,
}

/// Response payload for `tag_autocomplete`.
#[derive(Debug, Clone, Serialize)]
pub struct TagAutocompleteResponse {
    /// Candidate tag paths (no leading `#`), ordered, capped server-side.
    pub candidates: Vec<String>,
}

// -- close_vault ---------------------------------------------------------

/// Request payload for `close_vault`.
#[derive(Debug, Clone, Deserialize)]
pub struct CloseVaultRequest {
    /// Vault to close.
    pub vault_id: String,
}

// -- create_block_ref / get_broken_block_refs (L3 Session G) -------------

/// Request payload for `create_block_ref`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBlockRefRequest {
    /// Vault owning the target file.
    pub vault_id: String,
    /// Vault-relative path of the file whose block is being referenced.
    pub target_path: String,
    /// Byte offset into the target file identifying the block (the
    /// id is appended to the end of the line containing this offset).
    pub position: u64,
}

/// Response payload for `create_block_ref`.
#[derive(Debug, Clone, Serialize)]
pub struct CreateBlockRefResponse {
    /// The block id (no leading `^`) — newly minted or pre-existing.
    pub block_id: String,
}

/// Request payload for `get_broken_block_refs`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetBrokenBlockRefsRequest {
    /// Vault to inspect.
    pub vault_id: String,
}

/// Response payload for `get_broken_block_refs`.
#[derive(Debug, Clone, Serialize)]
pub struct GetBrokenBlockRefsResponse {
    /// Broken refs, ordered. Empty when none.
    pub refs: Vec<BrokenBlockRefDto>,
}

/// One broken block ref for the frontend (vault-health surfacing).
#[derive(Debug, Clone, Serialize)]
pub struct BrokenBlockRefDto {
    /// File containing the `[[…#^id]]`.
    pub source_file_path: String,
    /// Target file.
    pub target_file_path: String,
    /// Missing block id.
    pub target_block_id: String,
}

// -- block_id_autocomplete (L3 — [[#^ autocomplete) -------------------

/// Request payload for `block_id_autocomplete`.
#[derive(Debug, Clone, Deserialize)]
pub struct BlockIdAutocompleteRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Wiki-link target as written (no `[[`/`]]`/`#`/`|`). Resolved to
    /// a file path via the same rules as `resolve_link`.
    pub target_raw: String,
}

/// Response payload for `block_id_autocomplete`.
#[derive(Debug, Clone, Serialize)]
pub struct BlockIdAutocompleteResponse {
    /// Block ids defined in the resolved target file, ordered by
    /// position; empty when the target doesn't resolve. Capped
    /// server-side at AUTOCOMPLETE_LIMIT.
    pub candidates: Vec<String>,
}
