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

import Editor, { type EditorApi } from "./Editor";
import type { CanonicalDocument } from "./ast/types";
import {
  getSetting,
  listFiles,
  onVaultFileChanged,
  onVaultScanCancelled,
  onVaultScanComplete,
  onVaultScanProgress,
  openVault,
  readFileText,
  setSetting,
  writeFileText,
  type FileEntry,
  type ScanStatus,
} from "./api/ipc";
import {
  applyTheme,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./styles/theme";

/**
 * L2 Session A surface.
 *
 * Adds the editor's write-path on top of the L1 file list. The state
 * that matters for autosave + conflict detection lives here in App so
 * the buffer-the-user-is-leaving can be flushed *before* the new file
 * loads (per L2 spec §2.1 flush-on-file-change semantics).
 *
 * Per-file state:
 * - `seenHash`     — hash of the file as of the last read or own-write.
 * - `lastWrittenHash` — hash of the most recent successful write.
 *                       Used to drop the watcher's own-write echo
 *                       before any external-edit logic runs (§2.8).
 *
 * The 300ms autosave timer is a single ambient handle (the L2 surface
 * only ever has one buffer open). Flush triggers: idle debounce, blur,
 * file selection change, app quit.
 */
const AUTOSAVE_DEBOUNCE_MS = 300;

/** Header theme button cycle order (spec §2.5 / DoD §6). */
const NEXT_THEME_MODE: Record<ThemeMode, ThemeMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_ICON: Record<ThemeMode, string> = {
  system: "⚙",
  light: "☀",
  dark: "☾",
};

const App: Component = () => {
  const [vaultId, setVaultId] = createSignal<string | null>(null);
  const [vaultPath, setVaultPath] = createSignal<string | null>(null);
  const [scanStatus, setScanStatus] = createSignal<ScanStatus>("in_progress");
  const [filesProcessed, setFilesProcessed] = createSignal(0);
  const [filesTotalEstimate, setFilesTotalEstimate] = createSignal(0);
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [selectedContent, setSelectedContent] = createSignal<string | null>(
    null,
  );
  const [astSummary, setAstSummary] = createSignal<string>("");

  // Theme state. `themeMode` is the user's preference (persisted per
  // vault as `appearance.theme_mode`); `resolvedTheme` is the concrete
  // light/dark applied to `<html>` and handed to the editor. The
  // initial `applyTheme` runs at render so the app honors the OS
  // preference from first paint, before any vault is open.
  const [themeMode, setThemeMode] = createSignal<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>(
    applyTheme("system"),
  );

  // Conflict banner state — surfaces when an external edit lands on a
  // dirty buffer (spec §2.7). `externalHash` holds the most recent
  // unfamiliar hash so "Keep my edits" knows what's being overwritten.
  const [conflictExternalHash, setConflictExternalHash] = createSignal<
    string | null
  >(null);

  // Per-file hash bookkeeping. Non-reactive (signals are overkill here
  // and would cause spurious re-renders when only the bookkeeping
  // changes). The active file's hashes are read directly from these
  // when needed.
  let seenHash: string | null = null;
  let lastWrittenHash: string | null = null;
  // Tracks whether the buffer has unsaved changes vs. seenHash.
  let dirty = false;

  let editorApi: EditorApi | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingWrite: Promise<void> | null = null;

  let unlistenProgress: UnlistenFn | undefined;
  let unlistenComplete: UnlistenFn | undefined;
  let unlistenCancelled: UnlistenFn | undefined;
  let unlistenFileChanged: UnlistenFn | undefined;

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

  /**
   * Run the actual write. Resets `dirty` only if no new keystrokes
   * landed during the write (the editor remains the source of truth
   * for whether the buffer matches what we just persisted).
   */
  const performWrite = async (): Promise<void> => {
    const id = vaultId();
    const path = selectedPath();
    if (!id || !path || !editorApi) return;
    const content = editorApi.getContent();
    try {
      const req: Parameters<typeof writeFileText>[0] = {
        vault_id: id,
        path,
        content,
      };
      if (seenHash !== null) req.expected_seen_hash = seenHash;
      const resp = await writeFileText(req);
      lastWrittenHash = resp.new_content_hash;
      seenHash = resp.new_content_hash;
      // Only clear `dirty` if the buffer matches what we wrote. If a
      // keystroke landed mid-write, the buffer diverged and we still
      // owe another flush.
      if (editorApi.getContent() === content) {
        dirty = false;
      }
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
    }
  };

  /** Trigger a write now, queuing serially so two flushes don't race. */
  const flushAutosave = async (): Promise<void> => {
    if (autosaveTimer !== undefined) {
      clearTimeout(autosaveTimer);
      autosaveTimer = undefined;
    }
    // If nothing is pending and the buffer is clean, no-op.
    if (!dirty && pendingWrite === null) return;
    // Chain after any in-flight write so the second flush sees the
    // first's hash update.
    const prior = pendingWrite ?? Promise.resolve();
    const next = prior.then(performWrite);
    pendingWrite = next;
    try {
      await next;
    } finally {
      if (pendingWrite === next) pendingWrite = null;
    }
  };

  const scheduleAutosave = () => {
    if (conflictExternalHash() !== null) {
      // Banner is up — autosave is paused until the user resolves.
      return;
    }
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined;
      void flushAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const handleContentChange = (_content: string) => {
    dirty = true;
    scheduleAutosave();
  };

  const handleAstChange = (doc: CanonicalDocument) => {
    setAstSummary(
      `${doc.blocks.length} block${doc.blocks.length === 1 ? "" : "s"}, ` +
        `${doc.source_len} byte${doc.source_len === 1 ? "" : "s"}` +
        (doc.frontmatter
          ? `, frontmatter: ${doc.frontmatter.entries.length} key${doc.frontmatter.entries.length === 1 ? "" : "s"}`
          : ""),
    );
  };

  /**
   * Advance the theme one step (`system → light → dark → system`),
   * apply it, and persist the new mode to the open vault. With no
   * vault open the change is in-memory only — `appearance.theme_mode`
   * is vault-local, so there is nowhere to persist it yet.
   */
  const cycleTheme = () => {
    const next = NEXT_THEME_MODE[themeMode()];
    setThemeMode(next);
    setResolvedTheme(applyTheme(next));
    const id = vaultId();
    if (id) {
      setSetting(id, "appearance.theme_mode", next).catch((e) => {
        console.error("persisting theme_mode failed", e);
      });
    }
  };

  const handleSelectFile = async (file: FileEntry) => {
    if (file.type_id !== "markdown") return;
    const id = vaultId();
    if (!id) return;
    // Selecting the same file again is a no-op; don't flush and reload
    // a buffer that's already in front of the user.
    if (selectedPath() === file.path) return;

    // Flush the *previous* file's pending write before swapping. Per
    // §2.1: "the previous file's pending write is awaited before the
    // new file is read."
    await flushAutosave();

    setError(null);
    setConflictExternalHash(null);
    setSelectedPath(file.path);
    // Reset per-file hash bookkeeping. seenHash will be repopulated
    // below once the read response gets us a hash to anchor on.
    seenHash = null;
    lastWrittenHash = null;
    dirty = false;
    try {
      const resp = await readFileText({ vault_id: id, path: file.path });
      setSelectedContent(resp.content);
      // The watcher will eventually report a hash for this path via
      // its event payload; until then, we anchor seenHash against the
      // current `files.content_hash` indirectly: we wait for the first
      // hash-bearing `vault:file-changed` for this file, or for our
      // own next write. In practice the editor only needs seenHash to
      // be *non-null* for autosave to gate sensibly — and we get that
      // from our first write response. Until then, autosave omits the
      // expected_seen_hash (advisory in L2 §3.1).
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
      setSelectedContent(null);
    }
  };

  const reloadFromDisk = async () => {
    const id = vaultId();
    const path = selectedPath();
    if (!id || !path || !editorApi) return;
    try {
      const resp = await readFileText({ vault_id: id, path });
      editorApi.replaceContent(resp.content);
      setSelectedContent(resp.content);
      seenHash = conflictExternalHash();
      lastWrittenHash = null;
      dirty = false;
      setConflictExternalHash(null);
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
    }
  };

  const keepMyEdits = () => {
    // Resume autosave. The next write's `expected_seen_hash` carries
    // whatever `seenHash` we last knew about; the Rust handler will
    // detect the mismatch vs. the file's current hash and write the
    // `external_edit_override` audit_log row.
    setConflictExternalHash(null);
    scheduleAutosave();
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
      void refreshFileList();
    });
    unlistenCancelled = await onVaultScanCancelled((p) => {
      if (p.vault_id !== vaultId()) return;
      setScanStatus("cancelled");
    });
    unlistenFileChanged = await onVaultFileChanged((p) => {
      if (p.vault_id !== vaultId()) return;
      scheduleRefresh();

      // L2 §2.7 + §2.8: external-edit detection vs. own-write
      // suppression. Only relevant when the changed file is the one
      // currently open in the editor and a hash is present on the
      // payload (created/modified events).
      if (p.path !== selectedPath()) return;
      const incoming = p.new_content_hash;
      if (!incoming) return;

      // Own-write suppression first — drop the round-trip echo before
      // any conflict logic runs.
      if (incoming === lastWrittenHash) return;

      // External edit. Branch on dirty state per §2.7.5: clean buffer
      // → silent reload; dirty buffer → conflict banner.
      if (dirty || conflictExternalHash() !== null) {
        setConflictExternalHash(incoming);
        // Cancel any pending debounce — autosave is paused until the
        // user resolves the conflict.
        if (autosaveTimer !== undefined) {
          clearTimeout(autosaveTimer);
          autosaveTimer = undefined;
        }
      } else {
        // Clean buffer: silently re-read so the editor reflects disk.
        const id = vaultId();
        const path = selectedPath();
        if (!id || !path) return;
        readFileText({ vault_id: id, path })
          .then((resp) => {
            editorApi?.replaceContent(resp.content);
            setSelectedContent(resp.content);
            seenHash = incoming;
            dirty = false;
          })
          .catch((e) => {
            console.error("silent reload failed", e);
          });
      }
    });

    // App-quit / window-close flush (best effort, §2.1 flush triggers).
    // `beforeunload` is the only synchronous hook the webview exposes;
    // we kick the autosave and let the in-flight IPC race the close.
    const onBeforeUnload = () => {
      if (autosaveTimer !== undefined) {
        clearTimeout(autosaveTimer);
        autosaveTimer = undefined;
      }
      // No await available — fire-and-forget. The IPC will be queued
      // even if the webview tears down mid-flight.
      if (dirty) void performWrite();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));

    // Re-resolve the theme when the OS appearance changes — but only
    // while the user is in `system` mode (an explicit light/dark
    // choice ignores the OS).
    const unwatchTheme = watchSystemTheme(() => {
      if (themeMode() === "system") setResolvedTheme(applyTheme("system"));
    });
    onCleanup(unwatchTheme);
  });

  onCleanup(() => {
    unlistenProgress?.();
    unlistenComplete?.();
    unlistenCancelled?.();
    unlistenFileChanged?.();
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
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
      setSelectedPath(null);
      setSelectedContent(null);
      setAstSummary("");
      setConflictExternalHash(null);
      seenHash = null;
      lastWrittenHash = null;
      dirty = false;

      const resp = await openVault({ path: picked });
      setVaultId(resp.vault_id);
      setScanStatus(resp.scan_status);
      scheduleRefresh();

      // Apply this vault's stored theme preference, if any. Absent
      // key → keep the current (OS-default `system`) mode.
      try {
        const stored = await getSetting(resp.vault_id, "appearance.theme_mode");
        if (stored !== null) {
          setThemeMode(stored);
          setResolvedTheme(applyTheme(stored));
        }
      } catch (e) {
        console.error("loading theme_mode failed", e);
      }
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
            Layer 2 — Editing
          </p>
        </div>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "var(--space-3)",
          }}
        >
          <button
            type="button"
            onClick={cycleTheme}
            aria-label={`Cycle theme (current: ${themeMode()})`}
            title={`Theme: ${themeMode()}`}
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "2.25rem",
              height: "2.25rem",
              "font-size": "var(--text-base)",
              "line-height": "1",
              color: "var(--c-fg-secondary)",
              background: "var(--c-bg-secondary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-md)",
              cursor: "pointer",
              transition:
                "color var(--transition-fast), border-color var(--transition-fast)",
            }}
          >
            {THEME_ICON[themeMode()]}
          </button>
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
        </div>
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
          <div
            style={{
              display: "flex",
              gap: "var(--space-3)",
              flex: 1,
              "min-height": 0,
            }}
          >
            <ul
              style={{
                "list-style": "none",
                padding: 0,
                margin: 0,
                "overflow-y": "auto",
                flex: "0 0 18rem",
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
                {(file) => {
                  const isMarkdown = file.type_id === "markdown";
                  const isSelected = () => selectedPath() === file.path;
                  return (
                    <li
                      onClick={() => handleSelectFile(file)}
                      style={{
                        padding: "var(--space-2) var(--space-3)",
                        "font-family": "var(--font-mono)",
                        "font-size": "var(--text-xs)",
                        "border-bottom": "1px solid var(--c-border-subtle)",
                        display: "flex",
                        "justify-content": "space-between",
                        gap: "var(--space-3)",
                        cursor: isMarkdown ? "pointer" : "default",
                        background: isSelected()
                          ? "var(--c-bg-tertiary)"
                          : "transparent",
                        color: isMarkdown
                          ? "var(--c-fg-primary)"
                          : "var(--c-fg-muted)",
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                        }}
                      >
                        {file.path}
                      </span>
                      <span style={{ color: "var(--c-fg-muted)" }}>
                        {file.type_id}
                      </span>
                    </li>
                  );
                }}
              </For>
            </ul>
            <div
              style={{
                flex: 1,
                "min-width": 0,
                display: "flex",
                "flex-direction": "column",
                gap: "var(--space-2)",
              }}
            >
              <Show
                when={selectedContent() !== null}
                fallback={
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "center",
                      color: "var(--c-fg-muted)",
                      "font-size": "var(--text-sm)",
                      border: "1px dashed var(--c-border-subtle)",
                      "border-radius": "var(--radius-md)",
                    }}
                  >
                    Select a markdown file to open it.
                  </div>
                }
              >
                <Show when={conflictExternalHash() !== null}>
                  <div
                    role="alert"
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      gap: "var(--space-3)",
                      padding: "var(--space-2) var(--space-3)",
                      border: "1px solid var(--c-warning, var(--c-border-subtle))",
                      "border-left": "var(--space-1) solid var(--c-warning, var(--c-accent))",
                      "border-radius": "var(--radius-md)",
                      background: "var(--c-bg-secondary)",
                      "font-size": "var(--text-sm)",
                    }}
                  >
                    <span>This file was changed outside Cubical.</span>
                    <span style={{ display: "flex", gap: "var(--space-2)" }}>
                      <button
                        type="button"
                        onClick={reloadFromDisk}
                        style={{
                          padding: "var(--space-1) var(--space-3)",
                          "font-size": "var(--text-xs)",
                          "font-family": "var(--font-body)",
                          color: "var(--c-fg-primary)",
                          background: "var(--c-bg-tertiary)",
                          border: "1px solid var(--c-border-subtle)",
                          "border-radius": "var(--radius-sm, var(--radius-md))",
                          cursor: "pointer",
                        }}
                      >
                        Reload from disk
                      </button>
                      <button
                        type="button"
                        onClick={keepMyEdits}
                        style={{
                          padding: "var(--space-1) var(--space-3)",
                          "font-size": "var(--text-xs)",
                          "font-family": "var(--font-body)",
                          color: "var(--c-fg-inverse)",
                          background: "var(--c-accent)",
                          border: "none",
                          "border-radius": "var(--radius-sm, var(--radius-md))",
                          cursor: "pointer",
                        }}
                      >
                        Keep my edits
                      </button>
                    </span>
                  </div>
                </Show>
                <Editor
                  value={selectedContent() ?? ""}
                  resolvedTheme={resolvedTheme()}
                  onAstChange={handleAstChange}
                  onContentChange={handleContentChange}
                  onBlur={() => void flushAutosave()}
                  ref={(api) => {
                    editorApi = api;
                  }}
                />
                <p
                  style={{
                    color: "var(--c-fg-secondary)",
                    "font-size": "var(--text-xs)",
                    "font-family": "var(--font-mono)",
                    margin: 0,
                  }}
                >
                  AST: {astSummary()}
                </p>
              </Show>
            </div>
          </div>
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
