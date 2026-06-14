import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";

import Editor, { type EditorApi } from "./Editor";
import Properties from "./Properties";
import type { CanonicalDocument, Frontmatter } from "./ast/types";
import {
  createBlockRef,
  getBrokenBlockRefs,
  getSetting,
  listFiles,
  listTags,
  onVaultFileChanged,
  onVaultFlushComplete,
  onVaultPendingRewritesChanged,
  onVaultScanCancelled,
  onVaultScanComplete,
  onVaultScanProgress,
  openVault,
  readFileText,
  renameFile,
  setSetting,
  writeFileText,
  type BrokenBlockRef,
  type FileEntry,
  type ResolvedAnchor,
  type ScanStatus,
} from "./api/ipc";
import {
  createWikiLinkResolver,
  type WikiLinkResolver,
} from "./editor/wikilinkResolver";
import {
  createEmbedResolver,
  type EmbedResolver,
} from "./editor/embedResolver";
import {
  createDataviewRunner,
  type DataviewRunner,
} from "./editor/dataview";
import { isOwnWriteEcho } from "./ownWrite";
import {
  createAutocompleteProvider,
  type AutocompleteProvider,
} from "./editor/autocompleteProvider";
import { computeWindow } from "./virtualList";
import { buildFileTree, flattenTree, type FlatRow } from "./sidebar/fileTree";
import { buildBlockRefLink } from "./editor/blockRef";
import { formatBrokenBlockRefs } from "./statusbar/brokenRefs";
import PendingRewrites from "./statusbar/PendingRewrites";
import { ToastHost, showToast } from "./Toast";
import { validateRenameTarget } from "./fileRename";
import { resolveRawState } from "./editor/rawSource";
import {
  applyTheme,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./styles/theme";
import Backlinks from "./sidebar/Backlinks";
import UnlinkedMentions from "./sidebar/UnlinkedMentions";
import SearchPanel from "./sidebar/SearchPanel";
import TagPage from "./TagPage";
import OmniBar from "./omnibar/OmniBar";
import { type OmniItem, type RankedItem } from "./omnibar/ranker";

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

/**
 * File-list virtualization. A vault can hold tens of thousands of
 * files; rendering one DOM node each freezes the webview. The list
 * renders only the rows in the viewport (plus `FILE_LIST_OVERSCAN`
 * rows of margin), every row a fixed `FILE_ROW_HEIGHT` px tall.
 */
const FILE_ROW_HEIGHT = 32;
const FILE_LIST_OVERSCAN = 8;

/** Header theme button cycle order (spec §2.5 / DoD §6). */
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
  // Parsed frontmatter from the latest AST tick, fed to the Properties
  // UI (L2 Session F). Reset on file selection so a freshly opened doc
  // never briefly shows the previous file's rows before the first tick.
  const [propertiesFrontmatter, setPropertiesFrontmatter] =
    createSignal<Frontmatter | null>(null);

  // UI rework: live document stats shown in the status bar. Block count
  // comes from the canonical AST; word count from the current buffer text.
  const [blockCount, setBlockCount] = createSignal(0);
  const [wordCount, setWordCount] = createSignal(0);

  // File-list virtualization state. `scrollTop`/`viewportHeight` track
  // the scroll container; `fileWindow` derives the slice of rows to
  // mount, and `visibleFiles` is that slice. Only ~viewport-many rows
  // are ever in the DOM, so a 30k-file vault stays responsive.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(600);
  // UI rework: folder tree. `collapsedFolders` is the set of collapsed
  // folder paths; `treeRows` flattens the *visible* rows (folders + files
  // in expanded folders), virtualized exactly like the old flat list so a
  // 30k-file vault stays responsive — only the windowed slice is mounted.
  const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(
    new Set(),
  );
  const toggleFolder = (path: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const treeRows = createMemo<FlatRow[]>(() =>
    flattenTree(buildFileTree(files()), collapsedFolders()),
  );
  const fileWindow = createMemo(() =>
    computeWindow(
      scrollTop(),
      viewportHeight(),
      FILE_ROW_HEIGHT,
      treeRows().length,
      FILE_LIST_OVERSCAN,
    ),
  );
  const visibleRows = createMemo(() =>
    treeRows().slice(fileWindow().startIndex, fileWindow().endIndex),
  );

  // Theme state. `themeMode` is the user's preference (persisted per
  // vault as `appearance.theme_mode`); `resolvedTheme` is the concrete
  // light/dark applied to `<html>` and handed to the editor. The
  // initial `applyTheme` runs at render so the app honors the OS
  // preference from first paint, before any vault is open.
  const [themeMode, setThemeMode] = createSignal<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>(
    applyTheme("system"),
  );

  // Raw-source state (spec §2.3). `rawDefault` is the app-level
  // `editor.raw_source_default` setting, seeded on vault open; absent
  // → `false` (Live Preview out of the box). `rawOverride` is the
  // per-doc transient choice — `null` means "defer to the default" and
  // it resets to `null` on every file-selection change. `effectiveRaw`
  // collapses the two into the boolean the editor acts on.
  const [rawDefault, setRawDefault] = createSignal(false);
  const [rawOverride, setRawOverride] = createSignal<boolean | null>(null);
  const effectiveRaw = createMemo(() =>
    resolveRawState(rawOverride(), rawDefault()),
  );

  // Conflict banner state — surfaces when an external edit lands on a
  // dirty buffer (spec §2.7). `externalHash` holds the most recent
  // unfamiliar hash so "Keep my edits" knows what's being overwritten.
  const [conflictExternalHash, setConflictExternalHash] = createSignal<
    string | null
  >(null);

  // L3 Session B: per-vault wiki-link resolver (`null` when no vault
  // is open). Reset on vault open; invalidated on every
  // `vault:file-changed` so a freshly-created target flips from
  // "unresolved" to "resolved" without a reload.
  const [wikilinkResolver, setWikilinkResolver] =
    createSignal<WikiLinkResolver | null>(null);

  // L3 Session H.2 — per-vault embed resolver (mirrors wikilinkResolver
  // lifecycle). Created in `handleOpen`, cleared in close, invalidated
  // on every `vault:file-changed` so a freshly-resolvable embed flips
  // from "Couldn't resolve" to its content without a reload.
  const [embedResolver, setEmbedResolver] =
    createSignal<EmbedResolver | null>(null);

  // L4-D — per-vault dataview runner for ```query blocks (mirrors the
  // embed resolver lifecycle). Created in `handleOpen`, cleared on close,
  // invalidated on vault content change so results re-evaluate.
  const [dataviewRunner, setDataviewRunner] =
    createSignal<DataviewRunner | null>(null);

  // L3 Session F: per-vault autocomplete provider (`null` when no vault
  // is open). Parallels `wikilinkResolver` — reset on vault open,
  // cleared on vault close.
  const [autocompleteProvider, setAutocompleteProvider] =
    createSignal<AutocompleteProvider | null>(null);

  // L3 Session B: pending "create this note?" offer raised by a click
  // on an unresolved wiki-link. `null` = no offer up.
  const [createOffer, setCreateOffer] = createSignal<{ path: string } | null>(
    null,
  );

  // L3 Session E: the first non-file view in the app. `view` discriminates
  // between the editor pane and the virtual tag page; the file list and
  // sidebar persist across both. `tagRefreshTick` lets `vault:file-changed`
  // re-query the tag listing (a new file with the tag should appear).
  //
  // Selecting a file always switches back to `{ kind: "file" }` — the
  // user clicking a row in the file list expects the editor, not the
  // tag page they were just on.
  type View = { kind: "file" } | { kind: "tag"; tagPath: string };
  const [view, setView] = createSignal<View>({ kind: "file" });
  const [tagRefreshTick, setTagRefreshTick] = createSignal(0);

  // L3 Session C: right-sidebar shell state + backlinks refresh tick.
  // `rightSidebarCollapsed` mirrors the `ui.right_sidebar_collapsed`
  // vault-local setting (seeded on vault open, persisted on toggle).
  // `rightSidebarRefreshTick` is a monotonic counter that the Backlinks
  // and Unlinked Mentions panels watch — every `vault:file-changed`
  // event bumps it after a 200ms debounce so the panels refetch
  // without polling. (Renamed in Session I — the same tick now drives
  // both panels.)
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(false);
  // UI rework: the left sidebar (search + file tree) is a floating layer
  // that slides off-screen on collapse without reflowing the editor.
  const [leftCollapsed, setLeftCollapsed] = createSignal(false);
  const toggleLeftSidebar = () => setLeftCollapsed((v) => !v);
  // UI rework: Settings modal (theme + editor/vault prefs live here now).
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  type SettingsTab = "appearance" | "editor" | "vault" | "shortcuts";
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("appearance");
  const [rightSidebarRefreshTick, setRightSidebarRefreshTick] = createSignal(0);
  let rightSidebarRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS = 200;

  // L4-B: a monotonic counter the SearchPanel watches to re-run its
  // active query when vault content changes (an edit may now match, or
  // no longer match, the live query). Bumped — debounced — on any
  // `vault:file-changed` and after the open file's own autosave (whose
  // file-changed event is suppressed as an own-write). The search index
  // is already committed by the watcher before the event fires, so the
  // re-query sees fresh results.
  const [searchRefreshTick, setSearchRefreshTick] = createSignal(0);
  let searchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const SEARCH_REFRESH_DEBOUNCE_MS = 250;
  const scheduleSearchRefresh = () => {
    if (searchRefreshTimer !== undefined) clearTimeout(searchRefreshTimer);
    searchRefreshTimer = setTimeout(() => {
      searchRefreshTimer = undefined;
      setSearchRefreshTick((n) => n + 1);
    }, SEARCH_REFRESH_DEBOUNCE_MS);
  };

  // ── L4-C Omni-Bar (Cmd/Ctrl+K quick switcher over notes + tags) ─────
  const [omniOpen, setOmniOpen] = createSignal(false);
  const [vaultTags, setVaultTags] = createSignal<string[]>([]);
  const [tagsLoaded, setTagsLoaded] = createSignal(false);

  /** Filename stem (no dir, no `.md`) — a note's display title. */
  const fileStem = (path: string) => {
    const base = path.split("/").pop() ?? path;
    return base.endsWith(".md") ? base.slice(0, -3) : base;
  };

  /** Lazily load the full vault tag set for the Omni-Bar (cached). */
  const ensureTagsLoaded = async () => {
    const id = vaultId();
    if (!id || tagsLoaded()) return;
    try {
      const resp = await listTags({ vault_id: id });
      setVaultTags(resp.tags);
    } catch (e) {
      console.error("list_tags failed; Omni-Bar runs notes-only", e);
      setVaultTags([]);
    } finally {
      setTagsLoaded(true);
    }
  };
  // Invalidate the tag cache on vault content change (next open re-fetches).
  createEffect(
    on(
      () => searchRefreshTick(),
      () => {
        setTagsLoaded(false);
        // L4-D: vault content changed — re-evaluate ```query blocks.
        dataviewRunner()?.invalidate();
      },
      { defer: true },
    ),
  );

  const omniItems = createMemo<OmniItem[]>(() => {
    const notes: OmniItem[] = files()
      .filter((f) => f.type_id === "markdown")
      .map((f) => ({ kind: "note", title: fileStem(f.path), path: f.path }));
    const tags: OmniItem[] = vaultTags().map((t) => ({ kind: "tag", tag: t }));
    return [...notes, ...tags];
  });
  const recentNotes = createMemo<RankedItem[]>(() =>
    [...files()]
      .filter((f) => f.type_id === "markdown")
      .sort((a, b) => (b.mtime_unix ?? 0) - (a.mtime_unix ?? 0))
      .slice(0, 10)
      .map((f) => ({
        item: { kind: "note" as const, title: fileStem(f.path), path: f.path },
        score: 0,
        matchedIndices: [],
      })),
  );

  // L3 Session I: which right-sidebar panel is currently rendered.
  // Persisted as `ui.right_sidebar_panel` (default `backlinks`).
  type RightSidebarPanel = "backlinks" | "unlinked_mentions";
  const [rightSidebarPanel, setRightSidebarPanel] =
    createSignal<RightSidebarPanel>("backlinks");

  // L3 Session G: broken block refs surfaced in the footer status bar.
  const [brokenBlockRefs, setBrokenBlockRefs] = createSignal<BrokenBlockRef[]>(
    [],
  );
  let brokenBlockRefsTimer: ReturnType<typeof setTimeout> | undefined;

  // L3 Session J.2 — pending-rewrites count (driven by
  // `vault:pending-rewrites-changed`) + the right-click rename gesture
  // state. `contextMenu` is the floating menu anchored to a file row;
  // `renamingPath` is the row currently swapped for an inline input.
  const [pendingRewritesCount, setPendingRewritesCount] = createSignal(0);
  const [contextMenu, setContextMenu] = createSignal<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);

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
  let unlistenPendingChanged: UnlistenFn | undefined;
  let unlistenFlushComplete: UnlistenFn | undefined;

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
      // L4-B: the watcher commits this own-write to the search index but
      // suppresses its file-changed event, so refresh the search panel
      // here — editing the open file may change what the active query
      // matches.
      scheduleSearchRefresh();
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

  /**
   * "Copy block reference" gesture (L3 Session G). Flush the buffer so
   * disk bytes match the cursor offset, mint/reuse a `^id` at that line
   * via the backend (the sole minter), and copy the `[[path#^id]]` link.
   * The backend's disk write rides the silent-reload path to bring the
   * `^id` into the clean buffer — no conflict banner.
   */
  const handleCopyBlockRef = async (byteOffset: number): Promise<void> => {
    const id = vaultId();
    const path = selectedPath();
    if (!id || !path) return;
    try {
      await flushAutosave();
      const resp = await createBlockRef({
        vault_id: id,
        target_path: path,
        position: byteOffset,
      });
      await navigator.clipboard.writeText(
        buildBlockRefLink(path, resp.block_id),
      );
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
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

  /**
   * Bump the right-sidebar refresh tick after a 200ms debounce. Called
   * from the `vault:file-changed` listener — any vault file change
   * may have created or removed a link pointing at the open note
   * (Backlinks) or added/removed a plain-text mention (Unlinked
   * Mentions). Same tick fans out to both panels.
   */
  const scheduleRightSidebarRefresh = () => {
    if (rightSidebarRefreshTimer !== undefined) {
      clearTimeout(rightSidebarRefreshTimer);
    }
    rightSidebarRefreshTimer = setTimeout(() => {
      rightSidebarRefreshTimer = undefined;
      setRightSidebarRefreshTick((n) => n + 1);
    }, RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS);
  };

  /**
   * Re-query the vault's broken block refs (L3 Session G). A transient
   * IPC error keeps the prior value rather than flickering to empty.
   */
  const refreshBrokenBlockRefs = async (): Promise<void> => {
    const id = vaultId();
    if (!id) return;
    try {
      const resp = await getBrokenBlockRefs({ vault_id: id });
      setBrokenBlockRefs(resp.refs);
    } catch (e) {
      console.error("broken block-ref refresh failed", e);
    }
  };

  /** Debounced `refreshBrokenBlockRefs` for the file-changed firehose. */
  const scheduleBrokenBlockRefsRefresh = () => {
    if (brokenBlockRefsTimer !== undefined) {
      clearTimeout(brokenBlockRefsTimer);
    }
    brokenBlockRefsTimer = setTimeout(() => {
      brokenBlockRefsTimer = undefined;
      void refreshBrokenBlockRefs();
    }, RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS);
  };

  /**
   * L3 Session J.2 — commit a file rename. Validates locally first
   * (empty / same-path are caught client-side) and surfaces backend
   * rejections (existing destination, vault not open) through the
   * shared toast surface.
   */
  const handleRenameCommit = async (
    fromPath: string,
    rawTarget: string,
  ): Promise<void> => {
    const id = vaultId();
    if (!id) {
      setRenamingPath(null);
      return;
    }
    const validation = validateRenameTarget(fromPath, rawTarget);
    if (validation !== null) {
      if (validation.code !== "same") {
        showToast(validation.message);
      }
      setRenamingPath(null);
      return;
    }
    const target = rawTarget.trim();
    setRenamingPath(null);
    try {
      await renameFile({
        vault_id: id,
        from_path: fromPath,
        to_path: target,
      });
      // Follow the rename for the open buffer: the content is unchanged
      // (so seenHash/lastWrittenHash stay valid) but the path moved. Without
      // this, a second title edit would rename from a now-stale path and
      // autosave would write back to the old location.
      if (selectedPath() === fromPath) {
        setSelectedPath(target);
      }
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      showToast(message);
    }
  };

  /**
   * UI rework: commit an edit of the Obsidian-style filename title.
   * The title shows the basename stem (no dir, no `.md`); editing it
   * renames the file. We reconstruct `<dir>/<stem>.md` and defer to the
   * same rename pipeline the file-list uses — the filename *is* the
   * title, so nothing (no `# H1`) is ever written into the document.
   */
  const commitTitleRename = (fromPath: string, newStem: string) => {
    const stem = newStem.trim();
    if (!stem) return;
    const slash = fromPath.lastIndexOf("/");
    const dir = slash >= 0 ? fromPath.slice(0, slash + 1) : "";
    const target = `${dir}${stem}.md`;
    if (target === fromPath) return;
    void handleRenameCommit(fromPath, target);
  };

  /** Tree inline-rename: keep the file's folder, swap its basename. */
  const renameTarget = (fromPath: string, basename: string) => {
    const i = fromPath.lastIndexOf("/");
    const dir = i >= 0 ? fromPath.slice(0, i + 1) : "";
    return dir + basename.trim();
  };

  const handleContentChange = (_content: string) => {
    dirty = true;
    scheduleAutosave();
  };

  const handleAstChange = (doc: CanonicalDocument) => {
    setPropertiesFrontmatter(doc.frontmatter);
    setBlockCount(doc.blocks.length);
    const text = editorApi?.getContent() ?? selectedContent() ?? "";
    const trimmed = text.trim();
    setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
  };

  /**
   * Set the theme mode directly (from Settings ▸ Appearance), apply it,
   * and persist to the open vault. With no vault open the change is
   * in-memory only — `appearance.theme_mode` is vault-local.
   */
  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setResolvedTheme(applyTheme(mode));
    const id = vaultId();
    if (id) {
      setSetting(id, "appearance.theme_mode", mode).catch((e) => {
        console.error("persisting theme_mode failed", e);
      });
    }
  };

  /**
   * Flip the raw-source state for the current document only (naked
   * `</>` click, or the `Cmd/Ctrl+E` keybind). Sets the per-doc
   * override against the *current* effective state — no setting is
   * written.
   */
  const toggleRawSource = () => {
    setRawOverride(!effectiveRaw());
  };

  /**
   * Promote the current effective state to the app-level default
   * (`Shift`-click on `</>`). Persists `editor.raw_source_default` and
   * clears the per-doc override so the new default takes effect
   * immediately for the open document.
   */
  const setRawAsDefault = () => {
    const next = !effectiveRaw();
    setRawDefault(next);
    setRawOverride(null);
    const id = vaultId();
    if (id) {
      setSetting(id, "editor.raw_source_default", next).catch((e) => {
        console.error("persisting raw_source_default failed", e);
      });
    }
  };

  /** Set the raw-source default explicitly (from Settings ▸ Editor). */
  const setRawDefaultValue = (val: boolean) => {
    setRawDefault(val);
    setRawOverride(null);
    const id = vaultId();
    if (id) {
      setSetting(id, "editor.raw_source_default", val).catch((e) => {
        console.error("persisting raw_source_default failed", e);
      });
    }
  };

  /**
   * Toggle the right sidebar collapsed/expanded and persist the new
   * value to the vault. With no vault open the change is in-memory
   * only (the setting is vault-local — nowhere to persist yet).
   */
  const toggleRightSidebar = () => {
    const next = !rightSidebarCollapsed();
    setRightSidebarCollapsed(next);
    const id = vaultId();
    if (id) {
      setSetting(id, "ui.right_sidebar_collapsed", next).catch((e) => {
        console.error("persisting ui.right_sidebar_collapsed failed", e);
      });
    }
  };

  /**
   * L3 Session I — pick which right-sidebar panel to render. Persists
   * the choice as `ui.right_sidebar_panel` so the user's preference
   * sticks across sessions for this vault.
   */
  const handleRightSidebarSegmentChange = (id: string) => {
    if (id !== "backlinks" && id !== "unlinked_mentions") return;
    setRightSidebarPanel(id);
    const v = vaultId();
    if (v) {
      setSetting(v, "ui.right_sidebar_panel", id).catch((e) => {
        console.error("persisting ui.right_sidebar_panel failed", e);
      });
    }
  };

  const handleSelectFile = async (file: FileEntry) => {
    if (file.type_id !== "markdown") return;
    const id = vaultId();
    if (!id) return;
    // Picking a file always exits the tag view back to the editor —
    // even when the file is already selected. The user's expectation
    // when they click a file row is "show me that file", regardless
    // of where they were before.
    setView({ kind: "file" });
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
    // Per §2.3: the per-doc raw override is transient — a freshly
    // opened file starts from the current app default.
    setRawOverride(null);
    setPropertiesFrontmatter(null);
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

  // ---------------------------------------------------------------------
  // L3 Session B — wiki-link navigation + create-offer handlers.
  // ---------------------------------------------------------------------

  /**
   * Open the resolved target file. If the wiki-link carried a heading
   * anchor, scroll the editor to the matching heading after the file
   * has loaded. Block anchors are Session G territory — log + no-op.
   */
  const handleNavigateWikilink = async (
    path: string,
    anchor: ResolvedAnchor | null,
  ) => {
    const id = vaultId();
    if (!id) return;
    // Reuse the existing selection plumbing so autosave/seenHash/etc.
    // stay correct. If the target is outside the rendered list window,
    // fabricate a minimal FileEntry — handleSelectFile reads only
    // `path` + `type_id`.
    const existing = files().find((f) => f.path === path);
    const file = existing ?? {
      path,
      type_id: "markdown",
      size_bytes: 0,
      mtime_unix: 0,
    };
    await handleSelectFile(file);
    if (anchor === null) return;
    if (anchor.kind === "heading") {
      editorApi?.scrollToHeading(anchor.value);
    } else {
      // Block anchors arrive once Session G ships block-ref resolution
      // through the index. Log and no-op until then.
      console.debug(
        "wiki-link block anchor navigation deferred to L3 Session G",
        anchor.value,
      );
    }
  };

  const handleOfferCreateWikilink = (path: string) => {
    setCreateOffer({ path });
  };

  /**
   * L3 Session E — open the virtual tag page for `tagPath`. Flushes
   * the pending autosave before swapping the view so we don't leave
   * the buffer-the-user-is-leaving with unsaved edits (same contract
   * as `handleSelectFile`).
   */
  const handleNavigateTag = async (tagPath: string) => {
    await flushAutosave();
    setView({ kind: "tag", tagPath });
  };

  /** Exit the tag view back to the editor pane, with no file change. */
  const handleExitTagView = () => {
    setView({ kind: "file" });
  };

  const dismissCreateOffer = () => {
    setCreateOffer(null);
  };

  const acceptCreateOffer = async () => {
    const offer = createOffer();
    const id = vaultId();
    if (!offer || !id) return;
    setCreateOffer(null);
    try {
      await writeFileText({
        vault_id: id,
        path: offer.path,
        content: "",
      });
      // The newly-created file will land via `vault:file-changed`,
      // which also invalidates the resolver. Navigate immediately.
      await handleNavigateWikilink(offer.path, null);
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(message);
    }
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
      void refreshBrokenBlockRefs();
    });
    unlistenCancelled = await onVaultScanCancelled((p) => {
      if (p.vault_id !== vaultId()) return;
      setScanStatus("cancelled");
    });
    unlistenFileChanged = await onVaultFileChanged((p) => {
      if (p.vault_id !== vaultId()) return;
      scheduleRefresh();

      // L4-A-fix.1: skip resolver invalidation on the open file's own
      // autosave echo. An own write can't have changed another file's
      // content, so cached embed / wiki-link resolutions stay valid;
      // invalidating here would only thrash embed-card height and jump
      // the viewport (layer-4-spec §9.2). Other-file changes and
      // genuine external edits to the open file still invalidate.
      const ownWrite = isOwnWriteEcho({
        changedPath: p.path,
        selectedPath: selectedPath(),
        incomingHash: p.new_content_hash,
        lastWrittenHash,
      });
      if (!ownWrite) {
        // L3 Session B: a change may have created or removed a wiki-link
        // target — re-resolve on the next decoration rebuild.
        wikilinkResolver()?.invalidate();
        // L3 Session H.2: a change may have altered embed targets or
        // their contents — re-fetch on the next widget rebuild.
        embedResolver()?.invalidate();
        // L4-D: a change may have altered frontmatter/tags a ```query
        // block projects — re-evaluate on the next widget rebuild.
        dataviewRunner()?.invalidate();
      }

      // L3 Sessions C + I: any vault file change may have added/removed
      // a link pointing at the open note (Backlinks) or a plain-text
      // mention (Unlinked Mentions). Bump the right-sidebar tick after
      // a 200ms debounce so both panels refetch.
      scheduleRightSidebarRefresh();

      // L4-B: the change may now match (or stop matching) the active
      // search query — re-run it (debounced).
      scheduleSearchRefresh();

      // L3 Session G: a change may have created or healed a broken
      // block ref anywhere in the vault.
      scheduleBrokenBlockRefsRefresh();

      // L3 Session E: any vault file change may have added/removed a
      // file carrying the currently-open tag. Refresh on every change
      // when the tag view is up; no debounce — `vault:file-changed`
      // fires once per write and `refreshFileList` already debounces
      // the more expensive file-list query.
      if (view().kind === "tag") {
        setTagRefreshTick((n) => n + 1);
      }

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

    unlistenPendingChanged = await onVaultPendingRewritesChanged((p) => {
      if (p.vault_id !== vaultId()) return;
      setPendingRewritesCount(p.count);
    });
    unlistenFlushComplete = await onVaultFlushComplete((p) => {
      if (p.vault_id !== vaultId()) return;
      if (p.files_rewritten === 0 && p.refs_updated === 0) return;
      const refs = p.refs_updated;
      const files = p.files_rewritten;
      showToast(
        `Applied ${refs} reference update${refs === 1 ? "" : "s"} across ` +
          `${files} file${files === 1 ? "" : "s"}.`,
      );
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

    // L4-C: global Cmd/Ctrl+K toggles the Omni-Bar (no-op without a vault).
    const onGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (!vaultId()) return;
        e.preventDefault();
        void ensureTagsLoaded();
        setOmniOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", onGlobalKey));

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
    unlistenPendingChanged?.();
    unlistenFlushComplete?.();
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    if (rightSidebarRefreshTimer !== undefined)
      clearTimeout(rightSidebarRefreshTimer);
    if (searchRefreshTimer !== undefined) clearTimeout(searchRefreshTimer);
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
      setPropertiesFrontmatter(null);
      setBlockCount(0);
      setWordCount(0);
      setConflictExternalHash(null);
      setRawOverride(null);
      setCreateOffer(null);
      setRightSidebarRefreshTick(0);
      setBrokenBlockRefs([]);
      setPendingRewritesCount(0);
      setContextMenu(null);
      setRenamingPath(null);
      setTagRefreshTick(0);
      setView({ kind: "file" });
      setRightSidebarCollapsed(false);
      setRightSidebarPanel("backlinks");
      setWikilinkResolver(null);
      setEmbedResolver(null);
      setDataviewRunner(null);
      setAutocompleteProvider(null);
      seenHash = null;
      lastWrittenHash = null;
      dirty = false;

      const resp = await openVault({ path: picked });
      setVaultId(resp.vault_id);
      setScanStatus(resp.scan_status);
      setWikilinkResolver(createWikiLinkResolver(resp.vault_id));
      setEmbedResolver(createEmbedResolver(resp.vault_id));
      setDataviewRunner(
        createDataviewRunner(resp.vault_id, (path) =>
          void handleNavigateWikilink(path, null),
        ),
      );
      setAutocompleteProvider(createAutocompleteProvider(resp.vault_id));
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

      // Seed the raw-source default from this vault's settings. Absent
      // key → `false` (Live Preview is the out-of-the-box experience).
      try {
        const stored = await getSetting(
          resp.vault_id,
          "editor.raw_source_default",
        );
        setRawDefault(stored ?? false);
      } catch (e) {
        console.error("loading raw_source_default failed", e);
      }

      // Seed the right-sidebar collapsed state from this vault's
      // settings. Absent key → expanded (false). The shell is the
      // primary surface for backlinks/mentions; default-open is the
      // right out-of-the-box experience.
      try {
        const stored = await getSetting(
          resp.vault_id,
          "ui.right_sidebar_collapsed",
        );
        setRightSidebarCollapsed(stored ?? false);
      } catch (e) {
        console.error("loading ui.right_sidebar_collapsed failed", e);
      }

      // L3 Session I: seed which right-sidebar panel is selected.
      // Absent key → `backlinks` (preserves the Session C default).
      try {
        const stored = await getSetting(
          resp.vault_id,
          "ui.right_sidebar_panel",
        );
        if (stored !== null) setRightSidebarPanel(stored);
      } catch (e) {
        console.error("loading ui.right_sidebar_panel failed", e);
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
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar__flank topbar__flank--left">
          <button
            type="button"
            class="chrome-btn"
            onClick={toggleLeftSidebar}
            aria-label="Toggle file panel"
            aria-pressed={!leftCollapsed()}
            title="Toggle file panel"
          >
            {leftCollapsed() ? "⟩" : "⟨"}
          </button>
        </div>
        <div class="topbar__center">
          <div class="topbar__tabs">
            <Show
              when={!!vaultId() && view().kind === "file" && !!selectedPath()}
            >
              <div class="tab tab--active">{fileStem(selectedPath()!)}</div>
            </Show>
            <Show when={view().kind === "tag"}>
              <div class="tab tab--active">
                #{(view() as { kind: "tag"; tagPath: string }).tagPath}
              </div>
            </Show>
          </div>
          <button
            type="button"
            class="chrome-btn chrome-btn--mono topbar__source"
            classList={{ "chrome-btn--accent": effectiveRaw() }}
            onClick={(e) =>
              e.shiftKey ? setRawAsDefault() : toggleRawSource()
            }
            aria-label="Toggle raw source"
            aria-pressed={effectiveRaw()}
            title={
              effectiveRaw()
                ? "Raw source (Cmd/Ctrl+E · Shift-click sets default)"
                : "Live preview (Cmd/Ctrl+E · Shift-click sets default)"
            }
          >
            &lt;/&gt;
          </button>
        </div>
        <div class="topbar__flank topbar__flank--right">
          <button
            type="button"
            class="chrome-btn"
            onClick={toggleRightSidebar}
            aria-label="Toggle backlinks panel"
            aria-pressed={!rightSidebarCollapsed()}
            title="Toggle backlinks panel"
          >
            {rightSidebarCollapsed() ? "⟨" : "⟩"}
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
          <div class="empty-vault">
            <p>Pick a folder to open it as a vault.</p>
            <button
              type="button"
              class="chrome-btn chrome-btn--primary"
              onClick={handleOpen}
              disabled={busy()}
            >
              Open Vault
            </button>
          </div>
        }
      >
        <div class="stage">
          <aside
            class="side side--left"
            classList={{ "side--collapsed": leftCollapsed() }}
          >
            <div class="side__body">
              <SearchPanel
                vaultId={vaultId()}
                onNavigate={(path) => void handleNavigateWikilink(path, null)}
                refreshSignal={searchRefreshTick()}
              >
              <div
              role="listbox"
              aria-label="Vault files"
              ref={(el) => setViewportHeight(el.clientHeight || 600)}
              onScroll={(e) => {
                setScrollTop(e.currentTarget.scrollTop);
                setViewportHeight(e.currentTarget.clientHeight);
              }}
              style={{
                "overflow-y": "auto",
                position: "relative",
                flex: 1,
                "min-height": 0,
                "min-width": 0,
              }}
            >
              <Show
                when={files().length > 0}
                fallback={
                  <div
                    style={{
                      padding: "var(--space-3)",
                      "font-size": "var(--text-sm)",
                      color: "var(--c-fg-muted)",
                    }}
                  >
                    No files yet…
                  </div>
                }
              >
                {/* Spacer sized to the full list so the scrollbar is
                    accurate; only the windowed slice is mounted. */}
                <div
                  style={{
                    height: `${fileWindow().totalHeight}px`,
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      transform: `translateY(${fileWindow().offsetY}px)`,
                    }}
                  >
                    <For each={visibleRows()}>
                      {(row) => {
                        const folderPad = `calc(var(--space-2) + ${row.depth} * var(--space-4))`;
                        if (row.kind === "folder") {
                          return (
                            <div
                              class="tree-row tree-row--folder"
                              role="treeitem"
                              aria-expanded={!row.collapsed}
                              style={{
                                height: `${FILE_ROW_HEIGHT}px`,
                                "padding-left": folderPad,
                              }}
                              onClick={() => toggleFolder(row.path)}
                            >
                              <span class="tree-row__twisty">
                                {row.collapsed ? "▸" : "▾"}
                              </span>
                              <span class="tree-row__name">{row.name}</span>
                            </div>
                          );
                        }
                        const isMarkdown = row.typeId === "markdown";
                        const isSelected = () => selectedPath() === row.path;
                        const isRenaming = () => renamingPath() === row.path;
                        const display = () =>
                          isMarkdown && row.name.endsWith(".md")
                            ? row.name.slice(0, -3)
                            : row.name;
                        return (
                          <div
                            class="tree-row tree-row--file"
                            classList={{
                              "tree-row--selected": isSelected(),
                              "tree-row--muted": !isMarkdown,
                            }}
                            role="option"
                            aria-selected={isSelected()}
                            style={{
                              height: `${FILE_ROW_HEIGHT}px`,
                              "padding-left": `calc(${folderPad} + 1rem + var(--space-1))`,
                            }}
                            onClick={() => {
                              if (isRenaming()) return;
                              const entry = files().find(
                                (f) => f.path === row.path,
                              );
                              if (entry) void handleSelectFile(entry);
                            }}
                            onContextMenu={(e) => {
                              if (!isMarkdown) return;
                              e.preventDefault();
                              setContextMenu({
                                path: row.path,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                          >
                            <Show
                              when={isRenaming()}
                              fallback={
                                <span class="tree-row__name">{display()}</span>
                              }
                            >
                              <input
                                type="text"
                                class="tree-row__input"
                                value={row.name}
                                autofocus
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void handleRenameCommit(
                                      row.path,
                                      renameTarget(row.path, e.currentTarget.value),
                                    );
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    setRenamingPath(null);
                                  }
                                }}
                                onBlur={(e) =>
                                  void handleRenameCommit(
                                    row.path,
                                    renameTarget(row.path, e.currentTarget.value),
                                  )
                                }
                              />
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
              </SearchPanel>
              <div class="side__footer">
                <button
                  type="button"
                  class="vault-btn"
                  onClick={handleOpen}
                  disabled={busy()}
                  title="Switch vault"
                >
                  <span class="vault-btn__name">
                    {vaultPath()?.split("/").filter(Boolean).pop() ?? "vault"}
                  </span>
                  <span class="vault-btn__caret">⌄</span>
                </button>
                <button
                  type="button"
                  class="chrome-btn"
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Settings"
                  title="Settings"
                >
                  ⚙
                </button>
              </div>
            </div>
          </aside>
          <main class="editor-layer">
            <div class="editor-scroll">
              <div class="editor-inner">
              <Show
                when={view().kind === "file"}
                fallback={
                  <TagPage
                    vaultId={vaultId()}
                    tagPath={(view() as { kind: "tag"; tagPath: string }).tagPath}
                    refreshSignal={tagRefreshTick()}
                    onSelectFile={(path) =>
                      void handleNavigateWikilink(path, null)
                    }
                    onBack={handleExitTagView}
                  />
                }
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
                    }}
                  >
                    Select a markdown file to open it.
                  </div>
                }
              >
                <Show when={selectedPath()} keyed>
                  {(path) => (
                    <input
                      class="doc-title"
                      aria-label="File name"
                      spellcheck={false}
                      value={fileStem(path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.currentTarget.value = fileStem(path);
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={(e) =>
                        commitTitleRename(path, e.currentTarget.value)
                      }
                    />
                  )}
                </Show>
                <Show when={conflictExternalHash() !== null}>
                  <div
                    role="alert"
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      gap: "var(--space-3)",
                      padding: "var(--space-2) var(--space-3)",
                      border:
                        "1px solid var(--c-warning, var(--c-border-subtle))",
                      "border-left":
                        "var(--space-1) solid var(--c-warning, var(--c-accent))",
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
                <Show when={!effectiveRaw()}>
                  <Properties
                    frontmatter={propertiesFrontmatter()}
                    path={selectedPath() ?? ""}
                    getSource={() => editorApi?.getContent() ?? ""}
                    applyEdit={(from, to, text) =>
                      editorApi?.replaceRange(from, to, text)
                    }
                    onOpenRaw={() => setRawOverride(true)}
                    onNavigateTag={(tagPath) =>
                      void handleNavigateTag(tagPath)
                    }
                  />
                </Show>
                <Editor
                  value={selectedContent() ?? ""}
                  resolvedTheme={resolvedTheme()}
                  rawSource={effectiveRaw()}
                  wikilinkResolver={wikilinkResolver()}
                  embedResolver={embedResolver()}
                  dataviewRunner={dataviewRunner()}
                  openNotePath={selectedPath()}
                  autocompleteProvider={autocompleteProvider()}
                  onNavigateWikilink={(path, anchor) =>
                    void handleNavigateWikilink(path, anchor)
                  }
                  onOfferCreateWikilink={(path) =>
                    handleOfferCreateWikilink(path)
                  }
                  onNavigateTag={(tagPath) =>
                    void handleNavigateTag(tagPath)
                  }
                  onToggleRawSource={toggleRawSource}
                  onAstChange={handleAstChange}
                  onContentChange={handleContentChange}
                  onBlur={() => void flushAutosave()}
                  onCopyBlockRef={(off) => void handleCopyBlockRef(off)}
                  ref={(api) => {
                    editorApi = api;
                  }}
                />
              </Show>
              </Show>
              </div>
            </div>
          </main>
          <aside
            class="side side--right"
            classList={{ "side--collapsed": rightSidebarCollapsed() }}
          >
            <div class="side__body">
              <div role="tablist" aria-label="Sidebar panels" class="rs-tabs">
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightSidebarPanel() === "backlinks"}
                  class="rs-tab"
                  classList={{
                    "rs-tab--active": rightSidebarPanel() === "backlinks",
                  }}
                  onClick={() => handleRightSidebarSegmentChange("backlinks")}
                >
                  Backlinks
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightSidebarPanel() === "unlinked_mentions"}
                  class="rs-tab"
                  classList={{
                    "rs-tab--active":
                      rightSidebarPanel() === "unlinked_mentions",
                  }}
                  onClick={() =>
                    handleRightSidebarSegmentChange("unlinked_mentions")
                  }
                >
                  Mentions
                </button>
              </div>
              <div class="rs-body">
                <Show
                  when={rightSidebarPanel() === "backlinks"}
                  fallback={
                    <UnlinkedMentions
                      vaultId={vaultId()}
                      path={selectedPath()}
                      refreshSignal={rightSidebarRefreshTick()}
                      onRowClick={(path) =>
                        void handleNavigateWikilink(path, null)
                      }
                    />
                  }
                >
                  <Backlinks
                    vaultId={vaultId()}
                    path={selectedPath()}
                    refreshSignal={rightSidebarRefreshTick()}
                    onRowClick={(path) =>
                      void handleNavigateWikilink(path, null)
                    }
                  />
                </Show>
              </div>
            </div>
          </aside>
        </div>
      </Show>

      <OmniBar
        open={omniOpen()}
        items={omniItems()}
        recentNotes={recentNotes()}
        onClose={() => setOmniOpen(false)}
        onOpenNote={(path) => void handleNavigateWikilink(path, null)}
        onOpenTag={(tag) => void handleNavigateTag(tag)}
      />

      <Show when={settingsOpen()}>
        <div
          class="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => setSettingsOpen(false)}
        >
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              class="chrome-btn modal__close"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              ✕
            </button>
            <nav class="modal__nav">
              <h3 class="modal__navtitle">Settings</h3>
              <For
                each={
                  [
                    { id: "appearance", label: "🎨 Appearance" },
                    { id: "editor", label: "📝 Editor" },
                    { id: "vault", label: "🗄 Vault" },
                    { id: "shortcuts", label: "⌨ Shortcuts" },
                  ] as { id: SettingsTab; label: string }[]
                }
              >
                {(t) => (
                  <button
                    type="button"
                    class="modal__navitem"
                    classList={{
                      "modal__navitem--active": settingsTab() === t.id,
                    }}
                    onClick={() => setSettingsTab(t.id)}
                  >
                    {t.label}
                  </button>
                )}
              </For>
            </nav>
            <div class="modal__body">
              <Show when={settingsTab() === "appearance"}>
                <h2 class="modal__h2">Appearance</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Theme</div>
                    <div class="set-row__desc">
                      Follow the system, or force light / dark.
                    </div>
                  </div>
                  <div class="seg-control">
                    <For each={["system", "light", "dark"] as ThemeMode[]}>
                      {(m) => (
                        <button
                          type="button"
                          class="seg-control__btn"
                          classList={{
                            "seg-control__btn--active": themeMode() === m,
                          }}
                          onClick={() => setTheme(m)}
                        >
                          {THEME_ICON[m]} {m}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
              <Show when={settingsTab() === "editor"}>
                <h2 class="modal__h2">Editor</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">
                      Open notes in raw source by default
                    </div>
                    <div class="set-row__desc">
                      Otherwise notes open in Live Preview.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{ "seg-control__btn--active": !rawDefault() }}
                      onClick={() => setRawDefaultValue(false)}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{ "seg-control__btn--active": rawDefault() }}
                      onClick={() => setRawDefaultValue(true)}
                    >
                      On
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={settingsTab() === "vault"}>
                <h2 class="modal__h2">Vault</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Current vault</div>
                    <div class="set-row__desc">{vaultPath() ?? "—"}</div>
                  </div>
                  <button
                    type="button"
                    class="chrome-btn chrome-btn--primary"
                    onClick={handleOpen}
                    disabled={busy()}
                  >
                    Open another…
                  </button>
                </div>
              </Show>
              <Show when={settingsTab() === "shortcuts"}>
                <h2 class="modal__h2">Shortcuts</h2>
                <div class="kb-row">
                  <span>Open Omni-Bar</span>
                  <kbd>⌘/Ctrl</kbd>
                  <kbd>K</kbd>
                </div>
                <div class="kb-row">
                  <span>Toggle raw source / Live Preview</span>
                  <kbd>⌘/Ctrl</kbd>
                  <kbd>E</kbd>
                </div>
                <div class="kb-row">
                  <span>Copy block reference</span>
                  <kbd>⌘/Ctrl</kbd>
                  <kbd>⇧</kbd>
                  <kbd>B</kbd>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={createOffer() !== null}>
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "rgba(0, 0, 0, 0.32)",
            "z-index": 10,
          }}
          onClick={dismissCreateOffer}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--c-bg-primary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-md)",
              padding: "var(--space-4)",
              "min-width": "20rem",
              "max-width": "32rem",
              display: "flex",
              "flex-direction": "column",
              gap: "var(--space-3)",
              "box-shadow": "0 6px 24px rgba(0, 0, 0, 0.2)",
            }}
          >
            <p
              style={{
                margin: 0,
                "font-size": "var(--text-sm)",
                color: "var(--c-fg-primary)",
              }}
            >
              Create note{" "}
              <code
                style={{
                  "font-family": "var(--font-mono)",
                  "font-size": "var(--text-xs)",
                }}
              >
                {createOffer()!.path}
              </code>
              ?
            </p>
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                "justify-content": "flex-end",
              }}
            >
              <button
                type="button"
                onClick={dismissCreateOffer}
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
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void acceptCreateOffer()}
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
                Create note
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={vaultId()}>
        <footer class="statusbar">
          {/* left: vault dir + system status */}
          <span class="statusbar__group statusbar__group--proj">
            <span class="statusbar__dir" title={vaultPath() ?? ""}>
              {vaultPath() ?? vaultId()}
            </span>
            <Show when={scanStatus() === "in_progress"}>
              <span class="statusbar__sep">·</span>
              <span>
                Scanning… {filesProcessed()} / {filesTotalEstimate()}
              </span>
            </Show>
            <Show when={formatBrokenBlockRefs(brokenBlockRefs())}>
              {(display) => (
                <>
                  <span class="statusbar__sep">·</span>
                  <span
                    title={display().title}
                    style={{ color: "var(--c-warning, var(--c-accent))" }}
                  >
                    {display().label}
                  </span>
                </>
              )}
            </Show>
            <PendingRewrites
              vaultId={vaultId()}
              count={pendingRewritesCount()}
              onError={(m: string) => showToast(m)}
            />
          </span>

          {/* middle: current file info */}
          <Show when={view().kind === "file" && !!selectedPath()}>
            <span class="statusbar__group statusbar__mid">
              <b>{wordCount()}</b> words
              <span class="statusbar__sep">·</span>
              <b>{blockCount()}</b> blocks
            </span>
          </Show>

          {/* right: current file dir (vault-relative path) */}
          <span class="statusbar__group statusbar__group--file">
            <Show when={view().kind === "file" && selectedPath()}>
              <span class="statusbar__dir" title={selectedPath() ?? ""}>
                {selectedPath()}
              </span>
            </Show>
          </span>
        </footer>
      </Show>

      <Show when={contextMenu()}>
        {(menu) => (
          <>
            <div
              onClick={() => setContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu(null);
              }}
              style={{
                position: "fixed",
                inset: 0,
                "z-index": 12,
                background: "transparent",
              }}
            />
            <div
              role="menu"
              style={{
                position: "fixed",
                top: `${menu().y}px`,
                left: `${menu().x}px`,
                "min-width": "10rem",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-md)",
                "box-shadow": "var(--shadow-md)",
                padding: "var(--space-1) 0",
                "z-index": 13,
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const path = menu().path;
                  setContextMenu(null);
                  setRenamingPath(path);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  "text-align": "left",
                  padding: "var(--space-2) var(--space-3)",
                  background: "transparent",
                  border: "none",
                  color: "var(--c-fg-primary)",
                  "font-family": "var(--font-body)",
                  "font-size": "var(--text-sm)",
                  cursor: "pointer",
                }}
              >
                Rename…
              </button>
            </div>
          </>
        )}
      </Show>

      <ToastHost />
    </div>
  );
};

export default App;
