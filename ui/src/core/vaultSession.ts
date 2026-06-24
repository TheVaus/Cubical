import { createSignal } from "solid-js";

import type { ScanStatus } from "../api/ipc";

/**
 * Core substrate — the open vault's session identity.
 *
 * Holds the always-on facts every feature needs to address the backend:
 * which vault is open (`vaultId`), where it lives (`vaultPath`), and the
 * scan lifecycle (`scanStatus` + progress counters). This is part of the
 * substrate, not a feature: it knows nothing about backlinks, search,
 * properties, etc. — features read `vaultId` from here; this module never
 * reaches back into them.
 *
 * Exposed as a composable returning signals (rather than a Solid context)
 * so the composition root can destructure it into the same identifiers it
 * used before — the migration is mechanical and behaviour-preserving.
 */
export interface VaultSession {
  readonly vaultId: () => string | null;
  readonly setVaultId: (id: string | null) => void;
  readonly vaultPath: () => string | null;
  readonly setVaultPath: (path: string | null) => void;
  readonly scanStatus: () => ScanStatus;
  readonly setScanStatus: (status: ScanStatus) => void;
  readonly filesProcessed: () => number;
  readonly setFilesProcessed: (n: number) => void;
  readonly filesTotalEstimate: () => number;
  readonly setFilesTotalEstimate: (n: number) => void;
}

export function createVaultSession(): VaultSession {
  const [vaultId, setVaultId] = createSignal<string | null>(null);
  const [vaultPath, setVaultPath] = createSignal<string | null>(null);
  const [scanStatus, setScanStatus] = createSignal<ScanStatus>("in_progress");
  const [filesProcessed, setFilesProcessed] = createSignal(0);
  const [filesTotalEstimate, setFilesTotalEstimate] = createSignal(0);

  return {
    vaultId,
    setVaultId,
    vaultPath,
    setVaultPath,
    scanStatus,
    setScanStatus,
    filesProcessed,
    setFilesProcessed,
    filesTotalEstimate,
    setFilesTotalEstimate,
  };
}
