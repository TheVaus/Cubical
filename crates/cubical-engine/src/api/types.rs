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
    /// Every tracked folder path (vault-relative, no trailing slash).
    /// Lets the file tree render empty directories, which the
    /// files-derived tree can't represent on its own. Not paginated.
    pub folders: Vec<String>,
}

// -- create_file / create_folder -----------------------------------------

/// Request payload for `create_file`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateFileRequest {
    /// Vault to create the file in.
    pub vault_id: String,
    /// Parent directory (vault-relative, `""` for the root). The new
    /// file is created inside it with a collision-safe `Untitled` name.
    #[serde(default)]
    pub parent_dir: String,
}

/// Response payload for `create_file`.
#[derive(Debug, Clone, Serialize)]
pub struct CreateFileResponse {
    /// Vault-relative path of the newly created file.
    pub path: String,
}

/// Request payload for `create_file_at_path`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateFileAtPathRequest {
    /// Vault to create the file in.
    pub vault_id: String,
    /// Exact vault-relative path of the note to create (e.g.
    /// `"folder/Target.md"`). Must not already exist.
    pub path: String,
}

/// Response payload for `create_file_at_path`.
#[derive(Debug, Clone, Serialize)]
pub struct CreateFileAtPathResponse {
    /// Vault-relative path of the newly created file (normalized).
    pub path: String,
}

/// Request payload for `create_folder`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateFolderRequest {
    /// Vault to create the folder in.
    pub vault_id: String,
    /// Parent directory (vault-relative, `""` for the root). The new
    /// folder is created inside it with a collision-safe `Untitled
    /// Folder` name.
    #[serde(default)]
    pub parent_dir: String,
}

/// Response payload for `create_folder`.
#[derive(Debug, Clone, Serialize)]
pub struct CreateFolderResponse {
    /// Vault-relative path of the newly created folder.
    pub path: String,
}

/// Request payload for `delete_path`.
#[derive(Debug, Clone, Deserialize)]
pub struct DeletePathRequest {
    /// Vault to delete from.
    pub vault_id: String,
    /// Vault-relative path of the file or folder to delete.
    pub path: String,
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

/// Request payload for `list_tags`.
#[derive(Debug, Clone, Deserialize)]
pub struct ListTagsRequest {
    /// Vault whose tag index to list.
    pub vault_id: String,
}

/// Response payload for `list_tags` — every distinct tag path (no
/// leading `#`), ordered, uncapped. Feeds the L4-C Omni-Bar.
#[derive(Debug, Clone, Serialize)]
pub struct ListTagsResponse {
    /// All distinct tag paths in the vault.
    pub tags: Vec<String>,
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

// -- get_embed (L3 Session H.1) ----------------------------------------

/// Request payload for `get_embed`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetEmbedRequest {
    pub vault_id: String,
    /// Wiki-link target as written (no `[[`/`]]`/`|`). May include a
    /// `#heading` or `#^block-id` anchor.
    pub target_raw: String,
}

/// What kind of embed `get_embed` resolved the target to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmbedKind {
    /// Full note body (frontmatter stripped).
    Note,
    /// Heading-anchored section.
    Section,
    /// Block-anchored paragraph or list item.
    Block,
    /// Target didn't resolve to any file in the vault.
    Unresolved,
    /// Target resolved, but the named heading / block id wasn't found.
    MissingAnchor,
}

/// Response payload for `get_embed`.
#[derive(Debug, Clone, Serialize)]
pub struct GetEmbedResponse {
    pub kind: EmbedKind,
    /// Resolved vault-relative path. `None` only when kind=Unresolved.
    pub target_path: Option<String>,
    /// Extracted content. `None` when kind is Unresolved or
    /// MissingAnchor.
    pub content: Option<String>,
}

// -- get_property (property-reference interpolation) --------------------

/// Request payload for `get_property` — a cross-file `[[note.prop]]`
/// reference. Self-refs (`[[.prop]]`) are resolved on the frontend and
/// never reach this command.
#[derive(Debug, Clone, Deserialize)]
pub struct GetPropertyRequest {
    pub vault_id: String,
    /// Target note name as written (left of the dot), no `[[`/`]]`.
    pub note_raw: String,
    /// Top-level frontmatter key to read (right of the first dot).
    pub property: String,
}

/// Outcome of resolving a property reference.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyRefKind {
    /// Note resolved and the key held a renderable scalar.
    Resolved,
    /// The note name didn't resolve to any file in the vault.
    NoteUnresolved,
    /// Note resolved but the key was absent or not a scalar.
    PropertyMissing,
}

/// Response payload for `get_property`.
#[derive(Debug, Clone, Serialize)]
pub struct GetPropertyResponse {
    pub kind: PropertyRefKind,
    /// The scalar rendered to a display string. `None` unless `Resolved`.
    pub value: Option<String>,
}

// -- get_unlinked_mentions (L3 Session I) ------------------------------

/// Request payload for `get_unlinked_mentions`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetUnlinkedMentionsRequest {
    /// Vault whose files to scan.
    pub vault_id: String,
    /// Vault-relative path of the note whose title / aliases drive the
    /// scan. This note is excluded from the candidate source list.
    pub path: String,
}

/// Response payload for `get_unlinked_mentions`.
#[derive(Debug, Clone, Serialize)]
pub struct GetUnlinkedMentionsResponse {
    /// Mentions in `(source_path, position)` order. Empty when nothing
    /// matches.
    pub mentions: Vec<Mention>,
}

/// One unlinked-mention row surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct Mention {
    /// Vault-relative path of the source note containing the mention.
    pub source_path: String,
    /// Single-line context snippet, ~120 chars centred on `position`.
    pub context: String,
    /// Byte offset of the match start within `source_path`.
    pub position: u64,
    /// Byte length of the matched span (for the "link it" rewrite).
    pub byte_len: u64,
    /// The needle that matched, as supplied by the handler (the
    /// canonical title or one of the aliases — case-preserved as
    /// stored). Powers the alias-vs-title rewrite decision.
    pub needle: String,
}

// -- link_mention (L3 Session I) ---------------------------------------

/// Request payload for `link_mention`.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkMentionRequest {
    /// Vault containing the file to rewrite.
    pub vault_id: String,
    /// Vault-relative path of the source note (the file being edited).
    pub source_path: String,
    /// Byte offset of the matched span (from a `Mention.position`).
    pub position: u64,
    /// Byte length of the matched span (from a `Mention.byte_len`).
    pub byte_len: u64,
    /// Canonical title of the target note (the basename minus `.md`).
    /// This is what the produced `[[…]]` resolves to.
    pub target_title: String,
}

/// Response payload for `link_mention`.
#[derive(Debug, Clone, Serialize)]
pub struct LinkMentionResponse {
    /// SHA-256 of the file's new on-disk contents (lowercase hex).
    pub new_hash: String,
}

// -- L3 Session J: rename + pending-rewrites IPCs ----------------------

/// Request payload for `rename_file`.
#[derive(Debug, Clone, Deserialize)]
pub struct RenameFileRequest {
    /// Vault hosting the file being renamed.
    pub vault_id: String,
    /// Current vault-relative path (must already exist + be tracked).
    pub from_path: String,
    /// Target vault-relative path (must not already exist).
    pub to_path: String,
}

/// Response payload for `rename_file`.
#[derive(Debug, Clone, Serialize)]
pub struct RenameFileResponse {
    /// The newly-minted `rename_op_id` for this rename. Surfaces in the
    /// status-bar undo dropdown.
    pub rename_op_id: i64,
    /// New total pending-rewrites count for the vault, post-enqueue.
    pub pending_count: i64,
}

/// Request payload for `rename_tag`.
#[derive(Debug, Clone, Deserialize)]
pub struct RenameTagRequest {
    /// Vault hosting the tag.
    pub vault_id: String,
    /// Tag path without the leading `#` (e.g. `"work/active"`).
    pub old_tag: String,
    /// Replacement tag path without the leading `#`.
    pub new_tag: String,
}

/// Response payload for `rename_tag`.
#[derive(Debug, Clone, Serialize)]
pub struct RenameTagResponse {
    /// Newly-minted rename op id.
    pub rename_op_id: i64,
    /// New total pending-rewrites count for the vault, post-enqueue.
    pub pending_count: i64,
}

/// Request payload for `rename_block_id`.
#[derive(Debug, Clone, Deserialize)]
pub struct RenameBlockIdRequest {
    /// Vault hosting the block.
    pub vault_id: String,
    /// Vault-relative path of the file defining the block.
    pub file_path: String,
    /// Current block id without the leading `^`.
    pub old_id: String,
    /// Replacement block id without the leading `^`.
    pub new_id: String,
}

/// Response payload for `rename_block_id`.
#[derive(Debug, Clone, Serialize)]
pub struct RenameBlockIdResponse {
    /// Newly-minted rename op id.
    pub rename_op_id: i64,
    /// New total pending-rewrites count for the vault, post-enqueue.
    pub pending_count: i64,
}

/// Request payload for `flush_pending_rewrites`.
#[derive(Debug, Clone, Deserialize)]
pub struct FlushPendingRewritesRequest {
    /// Vault whose pending rows should be drained.
    pub vault_id: String,
}

/// Request payload for `flush_pending_rewrites_for_target`.
#[derive(Debug, Clone, Deserialize)]
pub struct FlushPendingRewritesForTargetRequest {
    /// Vault hosting the target file.
    pub vault_id: String,
    /// Vault-relative path of the file whose pending rewrites should be
    /// flushed. Other files' pending rows remain queued.
    pub target_file: String,
}

/// Response payload for both `flush_pending_rewrites` and
/// `flush_pending_rewrites_for_target`.
#[derive(Debug, Clone, Serialize)]
pub struct FlushPendingRewritesResponse {
    /// Number of files whose on-disk content actually changed.
    pub files_rewritten: i64,
    /// Number of pending rows whose textual substitution applied.
    pub refs_updated: i64,
}

/// Request payload for `get_pending_rewrites_count`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetPendingRewritesCountRequest {
    /// Vault to query.
    pub vault_id: String,
}

/// Response payload for `get_pending_rewrites_count`.
#[derive(Debug, Clone, Serialize)]
pub struct GetPendingRewritesCountResponse {
    /// Total pending rows across every target file in the vault.
    pub count: i64,
}

/// Request payload for `get_pending_rewrites_breakdown`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetPendingRewritesBreakdownRequest {
    /// Vault to query.
    pub vault_id: String,
}

/// One row in the pending-rewrites breakdown.
#[derive(Debug, Clone, Serialize)]
pub struct PendingRewriteBreakdownRow {
    /// Vault-relative path of the file with pending rows.
    pub target_file: String,
    /// Number of pending rows for `target_file`.
    pub count: i64,
}

/// Response payload for `get_pending_rewrites_breakdown`.
#[derive(Debug, Clone, Serialize)]
pub struct GetPendingRewritesBreakdownResponse {
    /// Per-target rows ordered by count descending; `target_file` is
    /// the tiebreaker for stable output.
    pub rows: Vec<PendingRewriteBreakdownRow>,
}

/// Request payload for `list_recent_rename_ops`.
#[derive(Debug, Clone, Deserialize)]
pub struct ListRecentRenameOpsRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Maximum number of ops to return. The status-bar dropdown caps at
    /// ~5 in practice; the IPC leaves the choice to the caller.
    pub limit: u32,
}

/// One recent rename op surfaced for the status-bar undo dropdown.
#[derive(Debug, Clone, Serialize)]
pub struct RecentRenameOp {
    /// Op id to pass to `undo_rename`.
    pub rename_op_id: i64,
    /// Representative kind for the group's leading icon (deterministic
    /// `MIN(rewrite_kind)` in lexicographic order — not semantic).
    pub kind: String,
    /// Number of pending rows belonging to this op.
    pub row_count: i64,
    /// Earliest `created_at` in the group; effectively the time the
    /// rename was enqueued (unix seconds).
    pub created_at: i64,
}

/// Response payload for `list_recent_rename_ops`.
#[derive(Debug, Clone, Serialize)]
pub struct ListRecentRenameOpsResponse {
    /// Ops newest-first.
    pub ops: Vec<RecentRenameOp>,
}

/// Request payload for `undo_rename`.
#[derive(Debug, Clone, Deserialize)]
pub struct UndoRenameRequest {
    /// Vault containing the op.
    pub vault_id: String,
    /// Op id from a `RecentRenameOp.rename_op_id`.
    pub rename_op_id: i64,
}

/// Response payload for `undo_rename`.
#[derive(Debug, Clone, Serialize)]
pub struct UndoRenameResponse {
    /// Number of pending rows the undo removed.
    pub removed: u64,
    /// New total pending-rewrites count for the vault.
    pub pending_count: i64,
}

// -- search ---------------------------------------------------------------
//
// L4-A IPC surface. The wire DTOs are the `cubical_search` types verbatim
// — re-exported here so the frontend has a single import path and so the
// future TS-types generator can derive everything from `api::types`.

pub use cubical_search::{
    FieldScope as SearchFieldScope, IndexHealth as SearchHealthDto, IndexState as SearchIndexState,
    IndexStatus as SearchIndexStatusDto, MatchedField as SearchMatchedField, SearchHit,
    SearchQuery, SearchResponse, SortMode as SearchSortMode,
};

/// Request payload for `search` — wraps the bare `SearchQuery` with the
/// vault id, matching the other multi-vault commands in this module.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Inner query.
    pub query: SearchQuery,
}

/// Request payload for `search_index_status` / `search_rebuild_index` /
/// `search_get_health` — all just need the vault id.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchVaultRequest {
    /// Vault to query / mutate.
    pub vault_id: String,
}

// -- reload_settings -------------------------------------------------------

/// Request payload for `reload_settings`.
#[derive(Debug, serde::Deserialize)]
pub struct ReloadSettingsRequest {
    pub vault_id: String,
}

/// Response payload for `reload_settings`.
#[derive(Debug, serde::Serialize)]
pub struct ReloadSettingsResponse {
    /// All durable settings after re-reading the file: dotted key → value.
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
}

// -- dataview (L4-D) ------------------------------------------------------
//
// Dataview-style query IPC. The query AST/parser/executor live in
// `cubical-query`; this is the wire surface. A bad query is reported in
// the `Error` variant rather than as a thrown IPC error, so the editor
// widget always renders a structured answer.

/// Request payload for `dataview_query`.
#[derive(Debug, Clone, Deserialize)]
pub struct DataviewQueryRequest {
    /// Vault to query.
    pub vault_id: String,
    /// The raw query source from the ```query fence.
    pub source: String,
}

/// Result of a `dataview_query` — always returned as `Ok`; a parse or
/// execution failure is carried in the `Error` variant.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DataviewResult {
    /// `LIST` — note links.
    List {
        /// Matching notes.
        notes: Vec<cubical_query::NoteRef>,
    },
    /// `TABLE` — columns + rows.
    Table {
        /// Column headers (the named frontmatter keys; the file column is implicit).
        columns: Vec<String>,
        /// Result rows.
        rows: Vec<cubical_query::Row>,
    },
    /// `COUNT`.
    Count {
        /// Number of matching files.
        count: usize,
    },
    /// A parse or execution error, phrased for display.
    Error {
        /// The error message.
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
