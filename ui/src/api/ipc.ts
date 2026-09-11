import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CanonicalDocument } from "../ast/types";
import { invoke } from "./transport";

export type ScanStatus = "in_progress" | "complete" | "cancelled";

export interface OpenVaultRequest {
  path: string;
}

export interface OpenVaultResponse {
  vault_id: string;
  scan_status: ScanStatus;
}

export interface RecentVault {
  path: string;
  last_opened_unix: number;
  exists: boolean;
}

export interface ListRecentVaultsResponse {
  vaults: RecentVault[];
}

export interface RemoveRecentVaultRequest {
  path: string;
}

export interface TabRecordDto {
  id: string;
  kind: "file" | "tag";
  path: string | null;
  tag_path: string | null;
}

export interface TabSessionDto {
  tabs: TabRecordDto[];
  active_id: string | null;
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
  watcher_live: boolean;
  flush_timer_live: boolean;
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
  folders: string[];
}

export interface CreateFileRequest {
  vault_id: string;
  parent_dir?: string;
}

export interface CreateFileResponse {
  path: string;
  content_hash: string;
}

export interface CreateFileAtPathRequest {
  vault_id: string;
  path: string;
}

export interface CreateFileAtPathResponse {
  path: string;
  content_hash: string;
}

export interface CreateFolderRequest {
  vault_id: string;
  parent_dir?: string;
}

export interface CreateFolderResponse {
  path: string;
}

export interface DeleteFileRequest {
  vault_id: string;
  path: string;
}

export interface CloseVaultRequest {
  vault_id: string;
}

export interface GetFrontmatterRequest {
  vault_id: string;
  path: string;
}

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

export interface ReadFileBytesRequest {
  vault_id: string;
  path: string;
}

export interface ReadFileBytesResponse {
  base64: string;
  mime: string;
  size_bytes: number;
}

export interface GetCanonicalAstRequest {
  vault_id: string;
  path: string;
}

export interface GetCanonicalAstResponse {
  document: CanonicalDocument;
}

export interface WriteFileTextRequest {
  vault_id: string;
  path: string;
  content: string;
  expected_seen_hash?: string;
}

export interface WriteFileTextResponse {
  new_content_hash: string;
  new_mtime_unix: number;
}

export type ResolvedAnchor =
  { kind: "heading"; value: string } | { kind: "block"; value: string };

export interface ResolveLinkRequest {
  vault_id: string;
  target_raw: string;
  source_path?: string;
}

export interface ResolveLinkResponse {
  target_path: string | null;
  anchor: ResolvedAnchor | null;
}

export interface GetBacklinksRequest {
  vault_id: string;
  path: string;
}

export interface Backlink {
  source_path: string;
  context: string;
  position: number;
}

export interface GetBacklinksResponse {
  backlinks: Backlink[];
}

export interface QueryTagPageRequest {
  vault_id: string;
  tag_path: string;
}

export interface TagPageFile {
  path: string;
  title: string;
}

export interface QueryTagPageResponse {
  files: TagPageFile[];
}

export type Setting =
  | { key: "editor.raw_source_default"; value: boolean }
  | { key: "editor.minimap_enabled"; value: boolean }
  | { key: "editor.colorize_raw_source"; value: boolean }
  | { key: "editor.live_tab_limit"; value: number }
  | { key: "appearance.theme_mode"; value: "light" | "dark" | "system" }
  | { key: "ui.right_sidebar_collapsed"; value: boolean }
  | {
      key: "ui.right_sidebar_panel";
      value: "backlinks" | "unlinked_mentions" | "integrity";
    }
  | { key: "ui.left_sidebar_mode"; value: "files" | "tags" }
  | { key: "pending_rewrites.flush_interval_secs"; value: number }
  | { key: "plugins.dataview_enabled"; value: boolean }
  | { key: "plugins.property_refs_enabled"; value: boolean }
  | { key: "plugins.math_enabled"; value: boolean }
  | { key: "plugins.equations_enabled"; value: boolean }
  | { key: "plugins.terminal_enabled"; value: boolean }
  | { key: "plugins.graph_view_enabled"; value: boolean }
  | { key: "properties.typed_enabled"; value: boolean }
  | { key: "properties.date_format_default"; value: string }
  | { key: "properties.default_currency"; value: string }
  | { key: "properties.tags_key_as_tags"; value: boolean }
  | { key: "statusbar.enabled"; value: boolean }
  | { key: "statusbar.show_vault_path"; value: boolean }
  | { key: "statusbar.show_file_path"; value: boolean }
  | { key: "statusbar.show_word_count"; value: boolean }
  | { key: "statusbar.show_block_count"; value: boolean }
  | { key: "wikilinks.rewrite_broken_links_on_rename"; value: boolean }
  | { key: "shortcuts.overrides"; value: Record<string, string> };

export type SettingValue<K extends Setting["key"]> = Extract<
  Setting,
  { key: K }
>["value"];

export interface GetSettingRequest {
  vault_id: string;
  key: string;
}

export interface GetSettingResponse {
  value: unknown;
}

export interface SetSettingRequest {
  vault_id: string;
  key: string;
  value: unknown;
}

export interface CubicalError {
  code: string;
  message: string;
}

export interface RenameFileRequest {
  vault_id: string;
  from_path: string;
  to_path: string;
}

export interface RenameFileResponse {
  rename_op_id: number;
  pending_count: number;
}

export interface RenameFolderRequest {
  vault_id: string;
  from_path: string;
  to_path: string;
}

export interface RenameFolderResponse {
  rename_op_id: number;
  pending_count: number;
}

export interface RenameTagRequest {
  vault_id: string;
  old_tag: string;
  new_tag: string;
}

export interface RenameTagResponse {
  rename_op_id: number;
  pending_count: number;
}

export interface RenameBlockIdRequest {
  vault_id: string;
  file_path: string;
  old_id: string;
  new_id: string;
}

export interface RenameBlockIdResponse {
  rename_op_id: number;
  pending_count: number;
}

export interface FlushPendingRewritesRequest {
  vault_id: string;
}

export interface FlushPendingRewritesForTargetRequest {
  vault_id: string;
  target_file: string;
}

export interface FlushPendingRewritesResponse {
  files_rewritten: number;
  refs_updated: number;
}

export interface GetPendingRewritesCountRequest {
  vault_id: string;
}

export interface GetPendingRewritesCountResponse {
  count: number;
}

export interface GetPendingRewritesBreakdownRequest {
  vault_id: string;
}

export interface PendingRewriteBreakdownRow {
  target_file: string;
  count: number;
}

export interface GetPendingRewritesBreakdownResponse {
  rows: PendingRewriteBreakdownRow[];
}

export interface ListRecentRenameOpsRequest {
  vault_id: string;
  limit: number;
}

export interface RecentRenameOp {
  rename_op_id: number;
  kind: string;
  row_count: number;
  created_at: number;
}

export interface ListRecentRenameOpsResponse {
  ops: RecentRenameOp[];
}

export interface UndoRenameRequest {
  vault_id: string;
  rename_op_id: number;
}

export interface UndoRenameResponse {
  removed: number;
  pending_count: number;
}

export function openVault(req: OpenVaultRequest): Promise<OpenVaultResponse> {
  return invoke("open_vault", { req });
}

export function listRecentVaults(): Promise<ListRecentVaultsResponse> {
  return invoke("list_recent_vaults");
}

export function removeRecentVault(
  req: RemoveRecentVaultRequest,
): Promise<void> {
  return invoke("remove_recent_vault", { req });
}

export function loadTabSession(vaultPath: string): Promise<TabSessionDto> {
  return invoke("load_tab_session", { vaultPath });
}

export function saveTabSession(
  vaultPath: string,
  session: TabSessionDto,
): Promise<void> {
  return invoke("save_tab_session", { vaultPath, session });
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

export function createFile(
  req: CreateFileRequest,
): Promise<CreateFileResponse> {
  return invoke("create_file", { req });
}

export function createFileAtPath(
  req: CreateFileAtPathRequest,
): Promise<CreateFileAtPathResponse> {
  return invoke("create_file_at_path", { req });
}

export function createFolder(
  req: CreateFolderRequest,
): Promise<CreateFolderResponse> {
  return invoke("create_folder", { req });
}

export function deleteFile(req: DeleteFileRequest): Promise<void> {
  return invoke("delete_path", { req });
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

export function readFileBytes(
  req: ReadFileBytesRequest,
): Promise<ReadFileBytesResponse> {
  return invoke("read_file_bytes", { req });
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

export function resolveLink(
  req: ResolveLinkRequest,
): Promise<ResolveLinkResponse> {
  const payload: Record<string, unknown> = {
    vault_id: req.vault_id,
    target_raw: req.target_raw,
  };
  if (req.source_path != null) {
    payload.source_path = req.source_path;
  }
  return invoke("resolve_link", { req: payload });
}

export function getBacklinks(
  req: GetBacklinksRequest,
): Promise<GetBacklinksResponse> {
  return invoke("get_backlinks", { req });
}

export function queryTagPage(
  req: QueryTagPageRequest,
): Promise<QueryTagPageResponse> {
  return invoke("query_tag_page", { req });
}

export interface ListTagsRequest {
  vault_id: string;
}

export interface ListTagsResponse {
  tags: string[];
}

export function listTags(req: ListTagsRequest): Promise<ListTagsResponse> {
  return invoke("list_tags", { req });
}

export interface ListTagAssignmentsRequest {
  vault_id: string;
}

export interface TagAssignmentDto {
  tag_path: string;
  file_path: string;
}

export interface ListTagAssignmentsResponse {
  assignments: TagAssignmentDto[];
}

export function listTagAssignments(
  req: ListTagAssignmentsRequest,
): Promise<ListTagAssignmentsResponse> {
  return invoke("list_tag_assignments", { req });
}

export interface GetUnlinkedMentionsRequest {
  vault_id: string;
  path: string;
}

export interface Mention {
  source_path: string;
  context: string;
  position: number;
  byte_len: number;
  needle: string;
}

export interface GetUnlinkedMentionsResponse {
  mentions: Mention[];
}

export interface LinkMentionRequest {
  vault_id: string;
  source_path: string;
  position: number;
  byte_len: number;
  target_title: string;
}

export interface LinkMentionResponse {
  new_hash: string;
}

export function getUnlinkedMentions(
  req: GetUnlinkedMentionsRequest,
): Promise<GetUnlinkedMentionsResponse> {
  return invoke("get_unlinked_mentions", { req });
}

export function linkMention(
  req: LinkMentionRequest,
): Promise<LinkMentionResponse> {
  return invoke("link_mention", { req });
}

export async function getSetting<K extends Setting["key"]>(
  vaultId: string,
  key: K,
): Promise<SettingValue<K> | null> {
  const resp = await invoke<GetSettingResponse>("get_setting", {
    req: { vault_id: vaultId, key },
  });
  return (resp.value ?? null) as SettingValue<K> | null;
}

export function setSetting<K extends Setting["key"]>(
  vaultId: string,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  return invoke("set_setting", { req: { vault_id: vaultId, key, value } });
}

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
  "created" | "modified" | "removed" | "renamed";

export interface VaultFileChanged {
  vault_id: string;
  path: string;
  kind: VaultFileChangeKind;
  from_path?: string;
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

export function renameFile(
  req: RenameFileRequest,
): Promise<RenameFileResponse> {
  return invoke("rename_file", { req });
}

export function renameFolder(
  req: RenameFolderRequest,
): Promise<RenameFolderResponse> {
  return invoke("rename_folder", { req });
}

export function renameTag(req: RenameTagRequest): Promise<RenameTagResponse> {
  return invoke("rename_tag", { req });
}

export function renameBlockId(
  req: RenameBlockIdRequest,
): Promise<RenameBlockIdResponse> {
  return invoke("rename_block_id", { req });
}

export function flushPendingRewrites(
  req: FlushPendingRewritesRequest,
): Promise<FlushPendingRewritesResponse> {
  return invoke("flush_pending_rewrites", { req });
}

export function flushPendingRewritesForTarget(
  req: FlushPendingRewritesForTargetRequest,
): Promise<FlushPendingRewritesResponse> {
  return invoke("flush_pending_rewrites_for_target", { req });
}

export function getPendingRewritesCount(
  req: GetPendingRewritesCountRequest,
): Promise<GetPendingRewritesCountResponse> {
  return invoke("get_pending_rewrites_count", { req });
}

export function getPendingRewritesBreakdown(
  req: GetPendingRewritesBreakdownRequest,
): Promise<GetPendingRewritesBreakdownResponse> {
  return invoke("get_pending_rewrites_breakdown", { req });
}

export function listRecentRenameOps(
  req: ListRecentRenameOpsRequest,
): Promise<ListRecentRenameOpsResponse> {
  return invoke("list_recent_rename_ops", { req });
}

export function undoRename(
  req: UndoRenameRequest,
): Promise<UndoRenameResponse> {
  return invoke("undo_rename", { req });
}

export interface VaultPendingRewritesChanged {
  vault_id: string;
  count: number;
}

export interface VaultFlushComplete {
  vault_id: string;
  files_rewritten: number;
  refs_updated: number;
}

export function onVaultPendingRewritesChanged(
  handler: (payload: VaultPendingRewritesChanged) => void,
): Promise<UnlistenFn> {
  return listen<VaultPendingRewritesChanged>(
    "vault:pending-rewrites-changed",
    (e) => handler(e.payload),
  );
}

export function onVaultFlushComplete(
  handler: (payload: VaultFlushComplete) => void,
): Promise<UnlistenFn> {
  return listen<VaultFlushComplete>("vault:flush-complete", (e) =>
    handler(e.payload),
  );
}

export interface VaultSettingChanged {
  vault_id: string;
  key: string;
  value: unknown;
}

export function onVaultSettingChanged(
  handler: (payload: VaultSettingChanged) => void,
): Promise<UnlistenFn> {
  return listen<VaultSettingChanged>("vault:setting-changed", (e) =>
    handler(e.payload),
  );
}
