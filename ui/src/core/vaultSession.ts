import { createSignal } from "solid-js";

import type { ScanStatus } from "../api/ipc";

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
