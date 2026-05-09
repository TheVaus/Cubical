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
