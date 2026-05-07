import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  listFiles,
  onVaultScanCancelled,
  onVaultScanComplete,
  onVaultScanProgress,
  openVault,
  type FileEntry,
  type ScanStatus,
} from "./api/ipc";

/**
 * Layer 0 UI.
 *
 * One window, one button. After a folder is picked the vault opens
 * non-blockingly: progress streams via `vault:scan-progress`, the file
 * list populates as rows appear, and `vault:scan-complete` flips the
 * status bar from "Scanning…" to the final count. All visual values
 * come from `styles/tokens.css` — no hardcoded colors / fonts /
 * spacings live here. Real UX lands at L2.
 */
const App: Component = () => {
  const [vaultId, setVaultId] = createSignal<string | null>(null);
  const [vaultPath, setVaultPath] = createSignal<string | null>(null);
  const [scanStatus, setScanStatus] = createSignal<ScanStatus>("in_progress");
  const [filesProcessed, setFilesProcessed] = createSignal(0);
  const [filesTotalEstimate, setFilesTotalEstimate] = createSignal(0);
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  let unlistenProgress: UnlistenFn | undefined;
  let unlistenComplete: UnlistenFn | undefined;
  let unlistenCancelled: UnlistenFn | undefined;

  // Throttle the listFiles refetch so a 10k-file vault doesn't issue
  // ten thousand round trips. The scan emits a progress event per file;
  // the UI catches up at most every 200ms.
  let pendingRefresh = false;
  let lastRefreshAt = 0;
  const REFRESH_INTERVAL_MS = 200;

  const refreshFileList = async () => {
    const id = vaultId();
    if (!id) return;
    try {
      const resp = await listFiles({ vault_id: id });
      setFiles(resp.files);
    } catch (e) {
      console.error("listFiles failed", e);
    }
  };

  const scheduleRefresh = () => {
    const now = Date.now();
    if (pendingRefresh) return;
    const wait = Math.max(0, REFRESH_INTERVAL_MS - (now - lastRefreshAt));
    pendingRefresh = true;
    setTimeout(async () => {
      pendingRefresh = false;
      lastRefreshAt = Date.now();
      await refreshFileList();
    }, wait);
  };

  onMount(async () => {
    unlistenProgress = await onVaultScanProgress((p) => {
      if (p.vault_id !== vaultId()) return;
      setFilesProcessed(p.files_processed);
      setFilesTotalEstimate(p.files_total_estimate);
      scheduleRefresh();
    });
    unlistenComplete = await onVaultScanComplete((p) => {
      if (p.vault_id !== vaultId()) return;
      setFilesProcessed(p.file_count);
      setFilesTotalEstimate(p.file_count);
      setScanStatus("complete");
      // Final refresh so the list matches the final count.
      void refreshFileList();
    });
    unlistenCancelled = await onVaultScanCancelled((p) => {
      if (p.vault_id !== vaultId()) return;
      setScanStatus("cancelled");
    });
  });

  onCleanup(() => {
    unlistenProgress?.();
    unlistenComplete?.();
    unlistenCancelled?.();
  });

  const handleOpen = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") {
        setBusy(false);
        return;
      }
      // Reset any prior vault's UI state before the new one fires events.
      setFiles([]);
      setFilesProcessed(0);
      setFilesTotalEstimate(0);
      setScanStatus("in_progress");
      setVaultPath(picked);

      const resp = await openVault({ path: picked });
      setVaultId(resp.vault_id);
      setScanStatus(resp.scan_status);
      // First refresh kicks off so the list isn't empty for tiny vaults
      // that scan-complete before the throttle elapses.
      scheduleRefresh();
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100vh",
        padding: "var(--space-5)",
        gap: "var(--space-4)",
        "font-family": "var(--font-body)",
        color: "var(--c-fg-primary)",
        background: "var(--c-bg-primary)",
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "baseline",
          "justify-content": "space-between",
          gap: "var(--space-4)",
        }}
      >
        <div>
          <h1 style={{ "font-size": "var(--text-2xl)", margin: 0 }}>Cubical</h1>
          <p
            style={{
              color: "var(--c-fg-secondary)",
              "font-size": "var(--text-sm)",
              margin: 0,
            }}
          >
            Layer 0 — Bedrock
          </p>
        </div>
        <button
          type="button"
          onClick={handleOpen}
          disabled={busy()}
          style={{
            padding: "var(--space-2) var(--space-4)",
            "font-size": "var(--text-sm)",
            "font-family": "var(--font-body)",
            color: "var(--c-fg-inverse)",
            background: "var(--c-accent)",
            border: "none",
            "border-radius": "var(--radius-md)",
            cursor: busy() ? "wait" : "pointer",
            transition: "background var(--transition-fast)",
          }}
        >
          Open Vault
        </button>
      </header>

      <Show when={error()}>
        <div
          role="alert"
          style={{
            color: "var(--c-error)",
            "font-size": "var(--text-sm)",
            "border-left": "var(--space-1) solid var(--c-error)",
            "padding-left": "var(--space-3)",
          }}
        >
          {error()}
        </div>
      </Show>

      <Show
        when={vaultId()}
        fallback={
          <p
            style={{
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-sm)",
              margin: 0,
            }}
          >
            Pick a folder to open it as a vault.
          </p>
        }
      >
        <section
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "var(--space-2)",
            "min-height": 0,
            flex: 1,
          }}
        >
          <p
            style={{
              color: "var(--c-fg-secondary)",
              "font-size": "var(--text-xs)",
              "font-family": "var(--font-mono)",
              margin: 0,
              "word-break": "break-all",
            }}
          >
            {vaultPath()}
          </p>
          <ul
            style={{
              "list-style": "none",
              padding: 0,
              margin: 0,
              "overflow-y": "auto",
              flex: 1,
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-md)",
              background: "var(--c-bg-secondary)",
            }}
          >
            <For
              each={files()}
              fallback={
                <li
                  style={{
                    padding: "var(--space-3)",
                    "font-size": "var(--text-sm)",
                    color: "var(--c-fg-muted)",
                  }}
                >
                  No files yet…
                </li>
              }
            >
              {(file) => (
                <li
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    "font-family": "var(--font-mono)",
                    "font-size": "var(--text-xs)",
                    "border-bottom": "1px solid var(--c-border-subtle)",
                    display: "flex",
                    "justify-content": "space-between",
                    gap: "var(--space-3)",
                  }}
                >
                  <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>
                    {file.path}
                  </span>
                  <span style={{ color: "var(--c-fg-muted)" }}>
                    {file.type_id}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={vaultId()}>
        <footer
          style={{
            "border-top": "1px solid var(--c-border-subtle)",
            "padding-top": "var(--space-3)",
            color: "var(--c-fg-secondary)",
            "font-size": "var(--text-xs)",
            "font-family": "var(--font-mono)",
            display: "flex",
            "justify-content": "space-between",
            gap: "var(--space-3)",
          }}
        >
          <span>
            {scanStatus() === "in_progress"
              ? `Scanning… ${filesProcessed()} / ${filesTotalEstimate()}`
              : scanStatus() === "complete"
                ? `${filesProcessed()} file${filesProcessed() === 1 ? "" : "s"}`
                : `Scan cancelled at ${filesProcessed()} file${filesProcessed() === 1 ? "" : "s"}`}
          </span>
          <span>{vaultId()}</span>
        </footer>
      </Show>
    </main>
  );
};

export default App;
