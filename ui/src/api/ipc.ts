/**
 * Single chokepoint for backend communication.
 *
 * Components call typed functions from this module — never raw `invoke()`,
 * never `@tauri-apps/api/*` directly. When the API surface grows, the cost
 * of finding-and-replacing is paid in one file. The transport today is
 * Tauri's `invoke` + event system; the file is named `ipc.ts` rather than
 * `tauri.ts` so a future transport swap doesn't leave a misleading filename.
 *
 * See `docs/migration-touchpoints.md` for the migration boundary.
 *
 * Backend contract: `docs/layer-0-spec.md` §8.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CanonicalDocument } from "../ast/types";

// ---------------------------------------------------------------------------
// Wire types — mirror the Rust structs in cubical-app/src/api/types.rs.
// ---------------------------------------------------------------------------

export type ScanStatus = "in_progress" | "complete" | "cancelled";

export interface OpenVaultRequest {
  path: string;
}

export interface OpenVaultResponse {
  vault_id: string;
  scan_status: ScanStatus;
}

export interface CancelVaultScanRequest {
  vault_id: string;
}

export interface GetVaultInfoRequest {
  vault_id: string;
}

export interface GetVaultInfoResponse {
  path: string;
  file_count: number;
  markdown_count: number;
  binary_count: number;
  schema_version: number;
  scan_status: ScanStatus;
}

export interface ListFilesRequest {
  vault_id: string;
  limit?: number;
  offset?: number;
}

export interface FileEntry {
  path: string;
  type_id: string;
  size_bytes: number;
  mtime_unix: number;
}

export interface ListFilesResponse {
  files: FileEntry[];
  total: number;
}

export interface CloseVaultRequest {
  vault_id: string;
}

export interface GetFrontmatterRequest {
  vault_id: string;
  path: string;
}

/**
 * One frontmatter key/value pair. `value` is whatever JSON shape the
 * source YAML had — scalar, array, or nested object — so callers
 * narrow it themselves.
 */
export interface FrontmatterEntry {
  key: string;
  value: unknown;
}

export interface GetFrontmatterResponse {
  entries: FrontmatterEntry[];
}

export interface ReadFileTextRequest {
  vault_id: string;
  path: string;
}

export interface ReadFileTextResponse {
  content: string;
}

export interface GetCanonicalAstRequest {
  vault_id: string;
  path: string;
}

/**
 * Wire shape for `get_canonical_ast`. The `document` field mirrors
 * the Rust `cubical_ast::Document` type — see `ui/src/ast/types.ts`
 * for the canonical AST type aliases that match it.
 */
export interface GetCanonicalAstResponse {
  document: CanonicalDocument;
}

export interface WriteFileTextRequest {
  vault_id: string;
  path: string;
  content: string;
  /**
   * Advisory in L2: if set and the on-disk hash differs at write time,
   * an `external_edit_override` audit_log row lands but the write still
   * proceeds. Hard rejection arrives in L8 alongside the merge UI.
   */
  expected_seen_hash?: string;
}

export interface WriteFileTextResponse {
  new_content_hash: string;
  new_mtime_unix: number;
}

/** Mirror of `cubical_app::api::types::ResolvedAnchor`. */
export type ResolvedAnchor =
  | { kind: "heading"; value: string }
  | { kind: "block"; value: string };

export interface ResolveLinkRequest {
  vault_id: string;
  /**
   * The wiki-link target as written, post-tokenizer: no surrounding
   * `[[…]]`, no leading `!` (embed), and with `|display` already split
   * off. May still carry an `#anchor` (the backend will split it
   * back out and return it in `anchor`).
   */
  target_raw: string;
  /** Reserved for future relative resolution; ignored in L3 Session A. */
  source_path?: string;
}

export interface ResolveLinkResponse {
  /**
   * Resolved vault-relative path, or `null` when no unique match
   * exists (missing, ambiguous, or empty target).
   */
  target_path: string | null;
  /** Parsed anchor if the target carried one. */
  anchor: ResolvedAnchor | null;
}

// ---------------------------------------------------------------------------
// get_backlinks (L3 Session C)
// ---------------------------------------------------------------------------

export interface GetBacklinksRequest {
  vault_id: string;
  /** Vault-relative path of the note whose backlinks to list. */
  path: string;
}

/** One backlink as surfaced to the frontend. */
export interface Backlink {
  /** Vault-relative path of the source note that links here. */
  source_path: string;
  /** Single-line context snippet (~120 chars). Empty when the source
   *  file is unreadable or its enclosing block has no text. */
  context: string;
  /** Byte offset of the link's opener within `source_path`. */
  position: number;
}

export interface GetBacklinksResponse {
  backlinks: Backlink[];
}

// ---------------------------------------------------------------------------
// query_tag_page (L3 Session E)
// ---------------------------------------------------------------------------

export interface QueryTagPageRequest {
  vault_id: string;
  /** Tag path without the leading `#`. Matched case-insensitively;
   *  descendants (`tag_path/…`) are included. */
  tag_path: string;
}

/** One file row in a virtual tag page. */
export interface TagPageFile {
  /** Vault-relative path to the file. */
  path: string;
  /** Display title — basename without the `.md` extension. */
  title: string;
}

export interface QueryTagPageResponse {
  /** Ordered by `path`; empty when no file matches. */
  files: TagPageFile[];
}

// ---------------------------------------------------------------------------
// link_autocomplete / tag_autocomplete (L3 Session F)
// ---------------------------------------------------------------------------

export interface LinkAutocompleteRequest {
  vault_id: string;
  /** Substring typed after `[[`. Empty lists the first page. */
  query: string;
}

/** One link-autocomplete candidate. */
export interface LinkCandidate {
  /** Vault-relative path — inserted as the wiki-link target. */
  path: string;
  /** Basename minus `.md` — shown as the dropdown label. */
  title: string;
}

export interface LinkAutocompleteResponse {
  candidates: LinkCandidate[];
}

export interface TagAutocompleteRequest {
  vault_id: string;
  /** Prefix typed after `#`. Empty lists the first page. */
  query: string;
}

export interface TagAutocompleteResponse {
  /** Tag paths without the leading `#`. */
  candidates: string[];
}

/**
 * Known vault-local settings, as a discriminated union of
 * `{ key, value }` pairs. The backend `config` table is generic
 * (any key, any JSON value); this union is the frontend's typed view
 * of it so a typo like `editor.raw_source_devault` fails to compile.
 *
 * Later layers extend this union with their own keys
 * (`editor.autosave_debounce_ms`, `properties.show_unknown`, ...).
 * Mirrors `docs/layer-2-spec.md` §3.4.
 */
export type Setting =
  | { key: "editor.raw_source_default"; value: boolean }
  | { key: "appearance.theme_mode"; value: "light" | "dark" | "system" }
  | { key: "ui.right_sidebar_collapsed"; value: boolean };

/** Narrows a `Setting` key to its corresponding value type. */
export type SettingValue<K extends Setting["key"]> = Extract<
  Setting,
  { key: K }
>["value"];

export interface GetSettingRequest {
  vault_id: string;
  key: string;
}

export interface GetSettingResponse {
  /** Decoded JSON value, or `null` when the key is absent. */
  value: unknown;
}

export interface SetSettingRequest {
  vault_id: string;
  key: string;
  value: unknown;
}

// `set_setting` returns an empty object; no response interface needed.

/**
 * Stable error shape from the backend. `code` matches a `CubicalError`
 * variant and is safe to switch on; `message` is for human-facing UI.
 */
export interface CubicalError {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

export function openVault(req: OpenVaultRequest): Promise<OpenVaultResponse> {
  return invoke("open_vault", { req });
}

export function cancelVaultScan(req: CancelVaultScanRequest): Promise<void> {
  return invoke("cancel_vault_scan", { req });
}

export function getVaultInfo(
  req: GetVaultInfoRequest,
): Promise<GetVaultInfoResponse> {
  return invoke("get_vault_info", { req });
}

export function listFiles(req: ListFilesRequest): Promise<ListFilesResponse> {
  return invoke("list_files", { req });
}

export function closeVault(req: CloseVaultRequest): Promise<void> {
  return invoke("close_vault", { req });
}

export function getFrontmatter(
  req: GetFrontmatterRequest,
): Promise<GetFrontmatterResponse> {
  return invoke("get_frontmatter", { req });
}

export function readFileText(
  req: ReadFileTextRequest,
): Promise<ReadFileTextResponse> {
  return invoke("read_file_text", { req });
}

export function getCanonicalAst(
  req: GetCanonicalAstRequest,
): Promise<GetCanonicalAstResponse> {
  return invoke("get_canonical_ast", { req });
}

export function writeFileText(
  req: WriteFileTextRequest,
): Promise<WriteFileTextResponse> {
  return invoke("write_file_text", { req });
}

/**
 * Resolve a wiki-link target to a vault-relative path via the libSQL
 * link index, with the anchor (if any) parsed out and echoed back.
 * Returns `target_path: null` when no unique match exists.
 */
export function resolveLink(
  req: ResolveLinkRequest,
): Promise<ResolveLinkResponse> {
  // Build the wire payload conditionally so `exactOptionalPropertyTypes`
  // doesn't reject an explicit `undefined` source_path. (Same pattern
  // as `writeFileText`'s expected_seen_hash.)
  const payload: Record<string, unknown> = {
    vault_id: req.vault_id,
    target_raw: req.target_raw,
  };
  if (req.source_path != null) {
    payload.source_path = req.source_path;
  }
  return invoke("resolve_link", { req: payload });
}

/**
 * List every backlink for `path` — every note that links here, with
 * a single-line context snippet drawn from the source. Backlinks are
 * ordered `(source_path, position)`. Empty list when nothing links.
 */
export function getBacklinks(
  req: GetBacklinksRequest,
): Promise<GetBacklinksResponse> {
  return invoke("get_backlinks", { req });
}

/**
 * List every file carrying `tag_path` or any of its descendants. Files
 * are sorted by path; titles are derived from each file's basename.
 * Empty list when nothing matches.
 */
export function queryTagPage(
  req: QueryTagPageRequest,
): Promise<QueryTagPageResponse> {
  return invoke("query_tag_page", { req });
}

/**
 * Candidate files for the `[[` link-autocomplete dropdown — markdown
 * paths matching `query` as a case-insensitive substring. Empty list
 * when nothing matches.
 */
export function linkAutocomplete(
  req: LinkAutocompleteRequest,
): Promise<LinkAutocompleteResponse> {
  return invoke("link_autocomplete", { req });
}

/**
 * Candidate tags for the `#` tag-autocomplete dropdown — distinct tag
 * paths whose lowercased form starts with `query`. Empty list when
 * nothing matches.
 */
export function tagAutocomplete(
  req: TagAutocompleteRequest,
): Promise<TagAutocompleteResponse> {
  return invoke("tag_autocomplete", { req });
}

// ---------------------------------------------------------------------------
// block_id_autocomplete (L3 — [[#^ block-id completion)
// ---------------------------------------------------------------------------

export interface BlockIdAutocompleteRequest {
  vault_id: string;
  /** Wiki-link target as written (no `[[`/`]]`/`#`/`|`). */
  target_raw: string;
}

export interface BlockIdAutocompleteResponse {
  /** Block ids in the resolved target file (ordered, capped). */
  candidates: string[];
}

/**
 * Block ids defined in the resolved target file, for the `[[…#^` editor
 * dropdown. Empty when the target doesn't resolve.
 */
export function blockIdAutocomplete(
  req: BlockIdAutocompleteRequest,
): Promise<BlockIdAutocompleteResponse> {
  return invoke("block_id_autocomplete", { req });
}

// ---------------------------------------------------------------------------
// create_block_ref / get_broken_block_refs (L3 Session G)
// ---------------------------------------------------------------------------

export interface CreateBlockRefRequest {
  vault_id: string;
  /** Vault-relative path of the file whose block is referenced. */
  target_path: string;
  /** Byte offset identifying the block (id appended to that line). */
  position: number;
}

export interface CreateBlockRefResponse {
  /** Block id (no leading `^`), minted or pre-existing. */
  block_id: string;
}

export interface GetBrokenBlockRefsRequest {
  vault_id: string;
}

export interface BrokenBlockRef {
  source_file_path: string;
  target_file_path: string;
  target_block_id: string;
}

export interface GetBrokenBlockRefsResponse {
  refs: BrokenBlockRef[];
}

/**
 * Lazily mint (or reuse) a `^block-id` on the line at `position` in
 * `target_path`, persisting it. Returns the block id.
 */
export function createBlockRef(
  req: CreateBlockRefRequest,
): Promise<CreateBlockRefResponse> {
  return invoke("create_block_ref", { req });
}

/** Every block ref whose target block id no longer exists. */
export function getBrokenBlockRefs(
  req: GetBrokenBlockRefsRequest,
): Promise<GetBrokenBlockRefsResponse> {
  return invoke("get_broken_block_refs", { req });
}

// ---------------------------------------------------------------------------
// get_embed (L3 Session H.1 — embed content extractor)
// ---------------------------------------------------------------------------

export interface GetEmbedRequest {
  vault_id: string;
  /** Wiki-link target as written (no `[[`/`]]`/`|`). May include
   *  a `#heading` or `#^block-id` anchor. */
  target_raw: string;
}

export type EmbedKind =
  | "note"
  | "section"
  | "block"
  | "unresolved"
  | "missing-anchor";

export interface GetEmbedResponse {
  kind: EmbedKind;
  /** Resolved vault-relative path; null only when kind === "unresolved". */
  target_path: string | null;
  /** Extracted content; null when kind is "unresolved" or "missing-anchor". */
  content: string | null;
}

/** Resolve `target_raw` and return its embedded content slice. */
export function getEmbed(req: GetEmbedRequest): Promise<GetEmbedResponse> {
  return invoke("get_embed", { req });
}

/**
 * Read a vault-local setting. The generic `K` narrows the result to
 * the value type declared for that key in {@link Setting}; an absent
 * key resolves to `null`.
 */
export async function getSetting<K extends Setting["key"]>(
  vaultId: string,
  key: K,
): Promise<SettingValue<K> | null> {
  const resp = await invoke<GetSettingResponse>("get_setting", {
    req: { vault_id: vaultId, key },
  });
  return (resp.value ?? null) as SettingValue<K> | null;
}

/**
 * Write a vault-local setting. The generic `K` constrains `value` to
 * the type declared for that key in {@link Setting}, so a wrong-typed
 * or misspelled key fails to compile.
 */
export function setSetting<K extends Setting["key"]>(
  vaultId: string,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  return invoke("set_setting", { req: { vault_id: vaultId, key, value } });
}

// ---------------------------------------------------------------------------
// Events. Each function returns the unlisten handle so components can wire
// it into Solid's `onCleanup`.
// ---------------------------------------------------------------------------

export interface VaultScanProgress {
  vault_id: string;
  files_processed: number;
  files_total_estimate: number;
}

export interface VaultScanComplete {
  vault_id: string;
  file_count: number;
  duration_ms: number;
}

export interface VaultScanCancelled {
  vault_id: string;
}

export type VaultFileChangeKind =
  | "created"
  | "modified"
  | "removed"
  | "renamed";

export interface VaultFileChanged {
  vault_id: string;
  path: string;
  kind: VaultFileChangeKind;
  /** Set only when `kind === "renamed"`. */
  from_path?: string;
  /**
   * Content hash after the watcher processed the event. Set for
   * `"created"` and `"modified"`; absent for `"removed"` / `"renamed"`.
   * L2's hash-gating uses this to suppress own-write echoes and detect
   * external edits (`docs/layer-2-spec.md` §2.7 + §2.8).
   */
  new_content_hash?: string;
}

export function onVaultScanProgress(
  handler: (payload: VaultScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<VaultScanProgress>("vault:scan-progress", (e) =>
    handler(e.payload),
  );
}

export function onVaultScanComplete(
  handler: (payload: VaultScanComplete) => void,
): Promise<UnlistenFn> {
  return listen<VaultScanComplete>("vault:scan-complete", (e) =>
    handler(e.payload),
  );
}

export function onVaultScanCancelled(
  handler: (payload: VaultScanCancelled) => void,
): Promise<UnlistenFn> {
  return listen<VaultScanCancelled>("vault:scan-cancelled", (e) =>
    handler(e.payload),
  );
}

export function onVaultFileChanged(
  handler: (payload: VaultFileChanged) => void,
): Promise<UnlistenFn> {
  return listen<VaultFileChanged>("vault:file-changed", (e) =>
    handler(e.payload),
  );
}
