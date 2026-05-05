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
 * In L0 the surface is empty; commands land in subsequent L0 sessions.
 * See `docs/layer-0-spec.md` §8.
 */

// Placeholder — typed wrappers will be added as commands come online.
// Example shape (to be filled in):
//
//   import { invoke } from "@tauri-apps/api/core";
//   import { listen, type UnlistenFn } from "@tauri-apps/api/event";
//
//   export interface OpenVaultRequest { path: string; }
//   export interface OpenVaultResponse { vault_id: string; scan_status: "in_progress" | "complete"; }
//
//   export function openVault(req: OpenVaultRequest): Promise<OpenVaultResponse> {
//     return invoke("open_vault", { req });
//   }
//
//   export interface VaultScanProgress {
//     vault_id: string; files_processed: number; files_total_estimate: number;
//   }
//   export function onVaultScanProgress(handler: (p: VaultScanProgress) => void): Promise<UnlistenFn> {
//     return listen<VaultScanProgress>("vault:scan-progress", e => handler(e.payload));
//   }

export {};
