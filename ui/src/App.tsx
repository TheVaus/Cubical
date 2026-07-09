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
  type JSX,
} from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";

import Editor, { type EditorApi } from "./Editor";
import Properties from "./Properties";
import { RecentVaultList } from "./RecentVaultList";
import ShortcutsPanel from "./settings/ShortcutsPanel";
import { DATE_FORMAT_TOKENS } from "./properties/dateFormats";
import { CURRENCY_CODES } from "./properties/format";
import type { CanonicalDocument, Frontmatter } from "./ast/types";
import {
  createBlockRef,
  createFile,
  createFileAtPath,
  createFolder,
  deleteFile,
  getBrokenBlockRefs,
  getSetting,
  listFiles,
  listRecentVaults,
  listTags,
  onVaultFileChanged,
  onVaultFlushComplete,
  onVaultPendingRewritesChanged,
  onVaultScanCancelled,
  onVaultScanComplete,
  onVaultScanProgress,
  openVault,
  readFileText,
  removeRecentVault,
  renameFile,
  renameFolder,
  writeFileText,
  type BrokenBlockRef,
  type FileEntry,
  type RecentVault,
  type ResolvedAnchor,
} from "./api/ipc";
import { createVaultSession } from "./core/vaultSession";
import { persistSetting, seedSetting } from "./core/settings";
import {
  resolveBindings,
  resolveGlobal,
  type Command,
} from "./core/commands";
import {
  emptyNav,
  navPush,
  navBack,
  navForward,
  navCurrent,
  canBack,
  canForward,
  type NavState,
} from "./navHistory";
import { errorMessage } from "./errorMessage";
import {
  createWikiLinkResolver,
  type WikiLinkResolver,
} from "./editor/wikilinkResolver";
import {
  createEmbedResolver,
  type EmbedResolver,
} from "./editor/embedResolver";
import {
  createPropertyResolver,
  type PropertyResolver,
} from "./editor/propertyResolver";
import { isValidNoteName, noteNameError } from "./vault/noteName";
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
import {
  buildFileTree,
  buildStableTreeRows,
  countFilesUnderFolder,
  splitFileName,
  type FlatRow,
} from "./sidebar/fileTree";
import { buildBlockRefLink } from "./editor/blockRef";
import { formatBrokenBlockRefs } from "./statusbar/brokenRefs";
import { formatPendingRewrites } from "./statusbar/pendingRewritesLabel";
import PendingRewrites from "./statusbar/PendingRewrites";
import {
  STATUSBAR_SEGMENTS,
  STATUSBAR_ENABLED_KEY,
  STATUSBAR_DEFAULT,
  VAULT_PATH_SEGMENT,
  FILE_PATH_SEGMENT,
  WORD_COUNT_SEGMENT,
  BLOCK_COUNT_SEGMENT,
  segmentVisible,
  type StatusbarSegment,
} from "./statusbar/segments";
import { leadingSeparators } from "./statusbar/separators";
import { ToastHost, showToast } from "./Toast";
import { reprefixNestedPath, validateRenameTarget } from "./fileRename";
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
import { OMNI_COMMANDS } from "./omnibar/commands";
import {
  CORE_PLUGINS,
  corePluginEnabled,
  type BooleanSettingKey,
} from "./settings/corePlugins";
import { toggleInfo, type InfoId } from "./settings/settingsInfo";
import { VaultSwitcher } from "./VaultSwitcher";

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

const contextMenuItemStyle: JSX.CSSProperties = {
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
};

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
  // Core substrate: the open vault's session identity. Features read
  // `vaultId` from here; this holder knows nothing about them.
  const {
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
  } = createVaultSession();
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [folders, setFolders] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // True from first paint until launch has decided whether to auto-open the
  // last vault. Suppresses the empty-vault landing during that window so it
  // doesn't flash on screen before the auto-opened vault appears.
  const [booting, setBooting] = createSignal(true);
  // Machine-local recent-vaults list (populated from the app-config store).
  const [recentVaults, setRecentVaults] = createSignal<RecentVault[]>([]);
  const refreshRecentVaults = async () => {
    try {
      const resp = await listRecentVaults();
      setRecentVaults(resp.vaults);
    } catch (e) {
      console.error("listRecentVaults failed", e);
      setRecentVaults([]);
    }
  };
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
  // `<For>` reconciles by object reference — `buildStableTreeRows` reuses
  // the previous row's reference whenever its content is unchanged, so a
  // vault-file-changed refresh (e.g. the open file's own autosave) doesn't
  // tear down and remount unrelated sidebar rows.
  let prevTreeRows: FlatRow[] = [];
  const treeRows = createMemo<FlatRow[]>(() => {
    prevTreeRows = buildStableTreeRows(
      prevTreeRows,
      files(),
      folders(),
      collapsedFolders(),
    );
    return prevTreeRows;
  });
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
  // `editor.minimap_enabled` — read-only Pretext minimap strip; seeded on
  // vault open, absent → `false` (opt-in companion surface).
  const [minimapEnabled, setMinimapEnabled] = createSignal(false);
  // `editor.colorize_raw_source` — when on, Raw Source mode paints
  // rendered-mode colors (wiki-links / links / tags → accent) onto the raw
  // markup without hiding or rendering anything. Seeded on vault open,
  // absent → `false`. Inert under Live Preview.
  const [colorizeSource, setColorizeSource] = createSignal(false);
  const effectiveRaw = createMemo(() =>
    resolveRawState(rawOverride(), rawDefault()),
  );

  // `wikilinks.rewrite_broken_links_on_rename` — repair broken links that
  // name a renamed file. Default on; seeded on vault open.
  const [rewriteBrokenLinks, setRewriteBrokenLinks] = createSignal(true);
  const setRewriteBrokenLinksValue = (val: boolean) => {
    setRewriteBrokenLinks(val);
    persistSetting(
      vaultId(),
      "wikilinks.rewrite_broken_links_on_rename",
      val,
    );
  };

  // Typed-properties feature flag + default date format, seeded on vault
  // open. Absent → disabled / "YYYY-MM-DD".
  const [typedProps, setTypedProps] = createSignal(false);
  const [dateDefault, setDateDefault] = createSignal("YYYY-MM-DD");
  const [currencyDefault, setCurrencyDefault] = createSignal("usd");
  const [tagsKeyAsTags, setTagsKeyAsTags] = createSignal(true);

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

  // Per-vault cross-file property resolver for `[[note.prop]]`. Invalidated
  // on every `vault:file-changed` so an edited frontmatter value flips to
  // its new value without a reload.
  const [propertyResolver, setPropertyResolver] =
    createSignal<PropertyResolver | null>(null);

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
  // Session-scoped editor navigation history (#4). Reactive wrapper over
  // the pure navHistory reducer so the topbar ‹ › buttons re-evaluate.
  const [navState, setNavState] = createSignal<NavState>(emptyNav);
  const navCanBack = createMemo(() => canBack(navState()));
  const navCanForward = createMemo(() => canForward(navState()));
  // UI rework: Settings modal (theme + editor/vault prefs live here now).
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // Minimal in-app vault-switcher popover (#3) — no persistence yet.
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = createSignal(false);
  // `shortcuts.overrides` — command id → key spec, only for commands the
  // user has rebound from default. Seeded on vault open, absent → `{}`
  // (every command at its factory default). `effectiveBindings` is what
  // both the global keydown handler and the editor's CM6 keymap actually
  // resolve against.
  const [shortcutOverrides, setShortcutOverrides] = createSignal<
    Record<string, string>
  >({});
  const setShortcutOverridesValue = (next: Record<string, string>) => {
    setShortcutOverrides(next);
    persistSetting(vaultId(), "shortcuts.overrides", next);
  };
  const effectiveBindings = createMemo(() =>
    resolveBindings(shortcutOverrides()),
  );
  type SettingsTab =
    | "appearance"
    | "editor"
    | "wikilinks"
    | "plugins"
    | "statusbar"
    | "vault"
    | "shortcuts";
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("appearance");
  // Which complex setting's info popover is open (`null` = none). One at a
  // time; toggling the same `ⓘ` closes it (spec §State).
  const [openInfo, setOpenInfo] = createSignal<InfoId | null>(null);
  const flipInfo = (id: InfoId) => setOpenInfo((cur) => toggleInfo(cur, id));
  const [corePlugins, setCorePlugins] = createSignal<Record<string, boolean>>({});
  // Configurable status bar: master enable + per-item visibility, keyed by
  // full setting key (e.g. "statusbar.show_word_count"). Seeded on vault open.
  const [statusbarConfig, setStatusbarConfig] = createSignal<
    Record<string, boolean>
  >({});
  const statusbarEnabled = () =>
    statusbarConfig()[STATUSBAR_ENABLED_KEY] ?? STATUSBAR_DEFAULT;
  const segVisible = (seg: StatusbarSegment) =>
    segmentVisible(statusbarConfig(), seg);
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
    const commands: OmniItem[] = OMNI_COMMANDS.map((c) => ({
      kind: "command",
      id: c.id,
      title: c.title,
    }));
    return [...notes, ...tags, ...commands];
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
    kind: "file" | "folder" | "empty";
    /** Right-clicked row's path; `""` for `kind === "empty"`. */
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<{
    path: string;
    kind: "file" | "folder";
    fileCount: number;
  } | null>(null);
  const [deleteInFlight, setDeleteInFlight] = createSignal(false);
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
      setFolders(resp.folders);
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
      const message = errorMessage(e);
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
      const message = errorMessage(e);
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
    isFolder = false,
  ): Promise<void> => {
    const id = vaultId();
    if (!id) {
      setRenamingPath(null);
      return;
    }
    const validation = validateRenameTarget(fromPath, rawTarget, isFolder);
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
      if (isFolder) {
        await renameFolder({ vault_id: id, from_path: fromPath, to_path: target });
      } else {
        await renameFile({ vault_id: id, from_path: fromPath, to_path: target });
      }
      // Follow the open buffer if it was the renamed file itself, or
      // was nested under the renamed folder — without this, autosave
      // would write back to a path that no longer exists.
      if (isFolder) {
        const sel = selectedPath();
        if (sel !== null) {
          const reprefixed = reprefixNestedPath(sel, fromPath, target);
          if (reprefixed !== null) {
            setSelectedPath(reprefixed);
          }
        }
      } else if (selectedPath() === fromPath) {
        setSelectedPath(target);
      }
      // Neither rename_file nor rename_folder emits `vault:file-changed`
      // — that only arrives later (and debounced) from the watcher's
      // disk-move echo. Proactively do the same invalidation a
      // file-change does so every open view reflects the rename
      // immediately instead of resolving stale wiki-link targets /
      // showing the old name in the tree and backlinks panel.
      wikilinkResolver()?.invalidate();
      embedResolver()?.invalidate();
      propertyResolver()?.invalidate();
      dataviewRunner()?.invalidate();
      void refreshFileList();
      scheduleRightSidebarRefresh();
    } catch (e) {
      const message = errorMessage(e);
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
    persistSetting(vaultId(), "appearance.theme_mode", mode);
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
    persistSetting(vaultId(), "editor.raw_source_default", next);
  };

  /** Set the raw-source default explicitly (from Settings ▸ Editor). */
  const setRawDefaultValue = (val: boolean) => {
    setRawDefault(val);
    setRawOverride(null);
    persistSetting(vaultId(), "editor.raw_source_default", val);
  };

  /** Set the minimap-enabled flag (from Settings ▸ Editor). */
  const setMinimapEnabledValue = (val: boolean) => {
    setMinimapEnabled(val);
    persistSetting(vaultId(), "editor.minimap_enabled", val);
  };

  /** Set the colorize-raw-source flag (from Settings ▸ Editor). */
  const setColorizeSourceValue = (val: boolean) => {
    setColorizeSource(val);
    persistSetting(vaultId(), "editor.colorize_raw_source", val);
  };

  /** Set the typed-properties flag (from Settings ▸ Editor). */
  const setTypedPropsValue = (val: boolean) => {
    setTypedProps(val);
    persistSetting(vaultId(), "properties.typed_enabled", val);
  };

  /** Set the default date format (from Settings ▸ Editor). */
  const setDateDefaultValue = (val: string) => {
    setDateDefault(val);
    persistSetting(vaultId(), "properties.date_format_default", val);
  };

  /** Set the default currency (from Settings ▸ Editor). */
  const setCurrencyDefaultValue = (val: string) => {
    setCurrencyDefault(val);
    persistSetting(vaultId(), "properties.default_currency", val);
  };

  /** Toggle rendering the `tags` property as tag chips (Settings ▸ Editor). */
  const setTagsKeyAsTagsValue = (val: boolean) => {
    setTagsKeyAsTags(val);
    persistSetting(vaultId(), "properties.tags_key_as_tags", val);
  };

  /** Set a core plugin's on/off state and persist to vault settings. */
  const setCorePlugin = (
    id: string,
    settingKey: BooleanSettingKey,
    value: boolean,
  ) => {
    const v = vaultId();
    if (!v) return;
    setCorePlugins((prev) => ({ ...prev, [id]: value }));
    persistSetting(v, settingKey, value);
  };

  /** Set a status-bar setting (master or a segment) and persist to the vault. */
  const setStatusbarSetting = (key: BooleanSettingKey, value: boolean) => {
    const v = vaultId();
    if (!v) return;
    setStatusbarConfig((prev) => ({ ...prev, [key]: value }));
    persistSetting(v, key, value);
  };

  /** Run an omni-bar command by id. */
  const handleRunCommand = (id: string) => {
    if (id === "statusbar.toggle") {
      setStatusbarSetting(STATUSBAR_ENABLED_KEY, !statusbarEnabled());
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
    persistSetting(vaultId(), "ui.right_sidebar_collapsed", next);
  };

  /**
   * L3 Session I — pick which right-sidebar panel to render. Persists
   * the choice as `ui.right_sidebar_panel` so the user's preference
   * sticks across sessions for this vault.
   */
  const handleRightSidebarSegmentChange = (id: string) => {
    if (id !== "backlinks" && id !== "unlinked_mentions") return;
    setRightSidebarPanel(id);
    persistSetting(vaultId(), "ui.right_sidebar_panel", id);
  };

  const handleSelectFile = async (
    file: FileEntry,
    knownHash?: string,
    opts?: { fromHistory?: boolean },
  ) => {
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
    if (!opts?.fromHistory) setNavState((s) => navPush(s, file.path));
    // Per §2.3: the per-doc raw override is transient — a freshly
    // opened file starts from the current app default.
    setRawOverride(null);
    setPropertiesFrontmatter(null);
    // Reset per-file hash bookkeeping. seenHash will be repopulated
    // below once the read response gets us a hash to anchor on. When the
    // caller already knows the on-disk hash (e.g. a file it just created),
    // seed both here instead — otherwise the watcher's `Created` echo for
    // that write races in as an unrecognized "external edit" (bug: false
    // "changed outside Cubical" banner right after create).
    seenHash = knownHash ?? null;
    lastWrittenHash = knownHash ?? null;
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
      const message = errorMessage(e);
      setError(message);
      setSelectedContent(null);
    }
  };

  /**
   * Editor back/forward navigation (#4). Moves the history cursor first,
   * then opens whatever it now points at via `handleSelectFile`'s
   * `fromHistory` opt-out so the move doesn't re-push itself. Falls back
   * to a synthetic `FileEntry` when the path isn't in the currently
   * loaded `files()` list (e.g. it scrolled out of a filtered view).
   */
  const navigateToHistoryPath = (path: string) => {
    const existing = files().find((f) => f.path === path);
    const file: FileEntry = existing ?? {
      path,
      type_id: "markdown",
      size_bytes: 0,
      mtime_unix: 0,
    };
    void handleSelectFile(file, undefined, { fromHistory: true });
  };
  const goBack = () => {
    const next = navBack(navState());
    if (next.index === navState().index) return;
    setNavState(next);
    const path = navCurrent(next);
    if (path) navigateToHistoryPath(path);
  };
  const goForward = () => {
    const next = navForward(navState());
    if (next.index === navState().index) return;
    setNavState(next);
    const path = navCurrent(next);
    if (path) navigateToHistoryPath(path);
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
      const message = errorMessage(e);
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
    knownHash?: string,
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
    // Same file already in front → its buffer is loaded, so scroll
    // immediately (and report a missing anchor). A different file loads
    // its content via a deferred effect, so queue the scroll to run when
    // that content lands rather than racing it.
    const alreadyOpen = selectedPath() === path;
    if (anchor !== null && !alreadyOpen) {
      editorApi?.requestAnchorScroll(anchor);
    }
    await handleSelectFile(file, knownHash);
    if (anchor !== null && alreadyOpen) {
      const found =
        anchor.kind === "heading"
          ? editorApi?.scrollToHeading(anchor.value)
          : editorApi?.scrollToBlock(anchor.value);
      if (found === false) notifyAnchorNotFound(anchor);
    }
  };

  /** Surface a transient "anchor not found" toast. */
  const notifyAnchorNotFound = (anchor: ResolvedAnchor) => {
    const what = anchor.kind === "heading" ? "Heading" : "Block";
    showToast(`${what} "${anchor.value}" not found in the linked note`);
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
      // `write_file_text` only writes files that already exist; a
      // not-yet-created wiki-link target needs the dedicated create
      // path (which inserts the files row + writes empty bytes).
      const resp = await createFileAtPath({ vault_id: id, path: offer.path });
      // The newly-created file also lands via `vault:file-changed`,
      // which invalidates the resolver. Navigate immediately.
      await handleNavigateWikilink(offer.path, null, resp.content_hash);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
    }
  };

  // Create a fresh "Untitled" note at the vault root and open it; the
  // user renames it via the editable title. Naming + collision handling
  // happen backend-side.
  const handleNewFile = async () => {
    const id = vaultId();
    if (!id) return;
    try {
      const resp = await createFile({ vault_id: id, parent_dir: "" });
      await refreshFileList();
      await handleNavigateWikilink(resp.path, null, resp.content_hash);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Create a fresh "Untitled Folder" at the vault root. It renders empty
  // (tracked in the folders index) so the user can drop notes into it.
  const handleNewFolder = async () => {
    const id = vaultId();
    if (!id) return;
    try {
      await createFolder({ vault_id: id, parent_dir: "" });
      await refreshFileList();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /**
   * Context-menu "New File" — scoped to `parentDir` (a right-clicked
   * folder's path, or `""` for empty-space/root). Unlike the toolbar's
   * `handleNewFile`, this doesn't navigate to the new file — it enters
   * inline rename mode so the user names it in one motion.
   */
  const handleContextMenuNewFile = async (parentDir: string) => {
    const id = vaultId();
    if (!id) return;
    try {
      const resp = await createFile({ vault_id: id, parent_dir: parentDir });
      await refreshFileList();
      setRenamingPath(resp.path);
    } catch (e) {
      showToast(errorMessage(e));
    }
  };

  /**
   * Context-menu "New Folder" — scoped to `parentDir`. Folders can't be
   * renamed yet (no backend support — spec's "Folder rename is out of
   * scope"), so this just creates it and lets the tree refresh show it,
   * matching the toolbar button's existing behavior.
   */
  const handleContextMenuNewFolder = async (parentDir: string) => {
    const id = vaultId();
    if (!id) return;
    try {
      await createFolder({ vault_id: id, parent_dir: parentDir });
      await refreshFileList();
    } catch (e) {
      showToast(errorMessage(e));
    }
  };

  /** Open the delete-confirm dialog for a right-clicked row. */
  const handleRequestDelete = (path: string, kind: "file" | "folder") => {
    const fileCount =
      kind === "folder"
        ? countFilesUnderFolder(buildFileTree(files(), folders()), path)
        : 0;
    setDeleteTarget({ path, kind, fileCount });
  };

  /** Confirm-dialog "Delete" — moves the target to the OS trash. */
  const handleConfirmDelete = async () => {
    const id = vaultId();
    const target = deleteTarget();
    if (!id || !target) return;
    setDeleteInFlight(true);
    try {
      await deleteFile({ vault_id: id, path: target.path });
      setDeleteTarget(null);
    } catch (e) {
      showToast(errorMessage(e));
    } finally {
      setDeleteInFlight(false);
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
        // Property refs: a change may have altered a referenced note's
        // frontmatter — re-resolve on the next widget rebuild.
        propertyResolver()?.invalidate();
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

    // Global shortcuts run through the core command registry. Commands are
    // built from App closures here (the substrate stays feature-agnostic).
    const globalCommands: Record<string, Command> = {
      "omnibar.toggle": {
        id: "omnibar.toggle",
        title: "Toggle Omni-Bar",
        when: () => vaultId() !== null,
        run: () => {
          void ensureTagsLoaded();
          setOmniOpen((v) => !v);
        },
      },
      "view.toggleSidebar": {
        id: "view.toggleSidebar",
        title: "Toggle left sidebar",
        when: () => vaultId() !== null,
        run: () => toggleLeftSidebar(),
      },
      "file.new": {
        id: "file.new",
        title: "New note",
        when: () => vaultId() !== null,
        run: () => void handleNewFile(),
      },
      "nav.back": {
        id: "nav.back",
        title: "Navigate back",
        when: () => navCanBack(),
        run: () => goBack(),
      },
      "nav.forward": {
        id: "nav.forward",
        title: "Navigate forward",
        when: () => navCanForward(),
        run: () => goForward(),
      },
    };
    const onGlobalKey = (e: KeyboardEvent) => {
      const c = resolveGlobal(effectiveBindings(), globalCommands, e);
      if (!c) return;
      e.preventDefault();
      c.run();
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

    // Recent vaults + auto-open the last one. Do this after the scan
    // listeners are wired so the auto-opened vault's progress events land.
    await refreshRecentVaults();
    const top = recentVaults()[0];
    if (top && top.exists) {
      // Awaited (not fire-and-forget) so `booting` stays true until the vault
      // is open — otherwise the landing paints for a frame before it appears.
      await openVaultByPath(top.path);
    }
    setBooting(false);
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

  /**
   * Open the vault at `path`: reset prior UI state, open it via IPC, and
   * seed this vault's settings. Owns busy + error handling. Shared by the
   * folder-picker (`handleOpen`), the recent-vaults list, and launch
   * auto-open.
   */
  const openVaultByPath = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      // Reset any prior vault's UI state before the new one fires events.
      setFiles([]);
      setFolders([]);
      setFilesProcessed(0);
      setFilesTotalEstimate(0);
      setScanStatus("in_progress");
      setVaultPath(path);
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
      setDeleteTarget(null);
      setRenamingPath(null);
      setTagRefreshTick(0);
      setView({ kind: "file" });
      setRightSidebarCollapsed(false);
      setRightSidebarPanel("backlinks");
      setShortcutOverrides({});
      setWikilinkResolver(null);
      setEmbedResolver(null);
      setPropertyResolver(null);
      setDataviewRunner(null);
      setAutocompleteProvider(null);
      seenHash = null;
      lastWrittenHash = null;
      dirty = false;

      const resp = await openVault({ path });
      setVaultId(resp.vault_id);
      setScanStatus(resp.scan_status);
      setWikilinkResolver(createWikiLinkResolver(resp.vault_id));
      setEmbedResolver(createEmbedResolver(resp.vault_id));
      setPropertyResolver(createPropertyResolver(resp.vault_id));
      setDataviewRunner(
        createDataviewRunner(resp.vault_id, (p) =>
          void handleNavigateWikilink(p, null),
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
      await seedSetting(
        resp.vault_id,
        "editor.raw_source_default",
        false,
        setRawDefault,
      );

      // Seed the minimap flag. Absent → off (opt-in companion surface).
      await seedSetting(
        resp.vault_id,
        "editor.minimap_enabled",
        false,
        setMinimapEnabled,
      );

      // Seed the colorize-raw-source flag. Absent → off (opt-in).
      await seedSetting(
        resp.vault_id,
        "editor.colorize_raw_source",
        false,
        setColorizeSource,
      );

      // Seed typed-properties flag + default date format (absent → off / ISO).
      // Off by default: inline `# type:` comments are slated for replacement
      // by a vault-level type registry (see the future-work spec), so we
      // don't write app metadata into `.md` files until a user opts in.
      await seedSetting(
        resp.vault_id,
        "wikilinks.rewrite_broken_links_on_rename",
        true,
        setRewriteBrokenLinks,
      );
      await seedSetting(
        resp.vault_id,
        "properties.typed_enabled",
        false,
        setTypedProps,
      );
      await seedSetting(
        resp.vault_id,
        "properties.date_format_default",
        "YYYY-MM-DD",
        setDateDefault,
      );
      await seedSetting(
        resp.vault_id,
        "properties.default_currency",
        "usd",
        setCurrencyDefault,
      );
      await seedSetting(
        resp.vault_id,
        "properties.tags_key_as_tags",
        true,
        setTagsKeyAsTags,
      );

      // Load each core plugin's enablement (absent ⇒ default).
      {
        const enab: Record<string, boolean> = {};
        for (const p of CORE_PLUGINS) {
          try {
            const stored = await getSetting(resp.vault_id, p.settingKey);
            enab[p.id] = stored ?? p.defaultEnabled;
          } catch (e) {
            console.error(`loading ${p.settingKey} failed`, e);
            enab[p.id] = p.defaultEnabled;
          }
        }
        setCorePlugins(enab);
      }

      // Seed status-bar config (master + each segment). Absent ⇒ default (on).
      {
        const cfg: Record<string, boolean> = {};
        const keys: BooleanSettingKey[] = [
          STATUSBAR_ENABLED_KEY,
          ...STATUSBAR_SEGMENTS.map((s) => s.settingKey),
        ];
        for (const k of keys) {
          try {
            cfg[k] = (await getSetting(resp.vault_id, k)) ?? STATUSBAR_DEFAULT;
          } catch (e) {
            console.error(`loading ${k} failed`, e);
            cfg[k] = STATUSBAR_DEFAULT;
          }
        }
        setStatusbarConfig(cfg);
      }

      // Seed the right-sidebar collapsed state from this vault's
      // settings. Absent key → expanded (false). The shell is the
      // primary surface for backlinks/mentions; default-open is the
      // right out-of-the-box experience.
      await seedSetting(
        resp.vault_id,
        "ui.right_sidebar_collapsed",
        false,
        setRightSidebarCollapsed,
      );

      // L3 Session I: seed which right-sidebar panel is selected.
      // Absent key → `backlinks` (the reset default above), so seeding the
      // fallback is a no-op — preserving the Session C default.
      await seedSetting(
        resp.vault_id,
        "ui.right_sidebar_panel",
        "backlinks",
        setRightSidebarPanel,
      );

      await seedSetting(
        resp.vault_id,
        "shortcuts.overrides",
        {},
        setShortcutOverrides,
      );

      void refreshRecentVaults();
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    await openVaultByPath(picked);
  };

  /** `ⓘ` button + its popover, anchored inside a `.set-row__control`. */
  const InfoButton = (props: { id: InfoId; children: JSX.Element }) => (
    <>
      <button
        type="button"
        class="set-info-btn"
        aria-label="About this setting"
        aria-expanded={openInfo() === props.id}
        onClick={() => flipInfo(props.id)}
      >
        ⓘ
      </button>
      <Show when={openInfo() === props.id}>
        <div class="set-info-pop" role="dialog" aria-label="Setting help">
          {props.children}
        </div>
      </Show>
    </>
  );

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
          <button
            type="button"
            class="chrome-btn"
            onClick={goBack}
            disabled={!navCanBack()}
            aria-label="Navigate back"
            title="Navigate back"
          >
            ‹
          </button>
          <button
            type="button"
            class="chrome-btn"
            onClick={goForward}
            disabled={!navCanForward()}
            aria-label="Navigate forward"
            title="Navigate forward"
          >
            ›
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
          // While `booting`, render nothing rather than the landing — on a
          // launch that auto-opens the last vault, the landing would
          // otherwise flash for a frame before the vault appears.
          <Show when={!booting()}>
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
              <Show when={recentVaults().length > 0}>
                <div class="empty-vault__recents">
                  <p class="empty-vault__recents-label">Recent vaults</p>
                  <RecentVaultList
                    vaults={recentVaults()}
                    onSwitch={(path) => void openVaultByPath(path)}
                    onRemove={(path) =>
                      void removeRecentVault({ path }).then(refreshRecentVaults)
                    }
                  />
                </div>
              </Show>
            </div>
          </Show>
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
                class="tree-header"
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  gap: "var(--space-2)",
                  padding: "var(--space-1) var(--space-2)",
                }}
              >
                <span
                  style={{
                    "font-size": "var(--text-xs)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.05em",
                    color: "var(--c-fg-muted)",
                  }}
                >
                  Files
                </span>
                <span style={{ display: "flex", gap: "var(--space-1)" }}>
                  <button
                    type="button"
                    class="tree-header__action"
                    title="New file"
                    aria-label="New file"
                    disabled={!vaultId()}
                    onClick={() => void handleNewFile()}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: vaultId() ? "pointer" : "default",
                      color: "var(--c-fg-secondary)",
                      "font-size": "var(--text-sm)",
                      padding: "var(--space-1)",
                      "line-height": 1,
                    }}
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    class="tree-header__action"
                    title="New folder"
                    aria-label="New folder"
                    disabled={!vaultId()}
                    onClick={() => void handleNewFolder()}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: vaultId() ? "pointer" : "default",
                      color: "var(--c-fg-secondary)",
                      "font-size": "var(--text-sm)",
                      padding: "var(--space-1)",
                      "line-height": 1,
                    }}
                  >
                    🗀
                  </button>
                </span>
              </div>
              <div
              role="listbox"
              aria-label="Vault files"
              ref={(el) => setViewportHeight(el.clientHeight || 600)}
              onScroll={(e) => {
                setScrollTop(e.currentTarget.scrollTop);
                setViewportHeight(e.currentTarget.clientHeight);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ kind: "empty", path: "", x: e.clientX, y: e.clientY });
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
                when={treeRows().length > 0}
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
                          const isRenamingFolder = () => renamingPath() === row.path;
                          return (
                            <div
                              class="tree-row tree-row--folder"
                              role="treeitem"
                              aria-expanded={!row.collapsed}
                              style={{
                                height: `${FILE_ROW_HEIGHT}px`,
                                "padding-left": folderPad,
                              }}
                              onClick={() => {
                                if (isRenamingFolder()) return;
                                toggleFolder(row.path);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                  kind: "folder",
                                  path: row.path,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                            >
                              <span class="tree-row__twisty">
                                {row.collapsed ? "▸" : "▾"}
                              </span>
                              <Show
                                when={isRenamingFolder()}
                                fallback={
                                  <span class="tree-row__name">{row.name}</span>
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
                                        true,
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
                                      true,
                                    )
                                  }
                                />
                              </Show>
                            </div>
                          );
                        }
                        const isMarkdown = row.typeId === "markdown";
                        const isSelected = () => selectedPath() === row.path;
                        const isRenaming = () => renamingPath() === row.path;
                        const parts = () => splitFileName(row.name);
                        return (
                          <div
                            class="tree-row tree-row--file"
                            classList={{
                              "tree-row--selected": isSelected(),
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
                              e.stopPropagation();
                              setContextMenu({
                                kind: "file",
                                path: row.path,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                          >
                            <Show
                              when={isRenaming()}
                              fallback={
                                <span
                                  class="tree-row__name"
                                  classList={{
                                    "tree-row__name--dotted":
                                      isMarkdown && !isValidNoteName(row.name),
                                  }}
                                  title={
                                    isMarkdown && !isValidNoteName(row.name)
                                      ? noteNameError(row.name)
                                      : undefined
                                  }
                                >
                                  {parts().stem}
                                  <Show when={parts().ext !== ""}>
                                    <span class="tree-row__ext">
                                      .{parts().ext}
                                    </span>
                                  </Show>
                                  <Show
                                    when={isMarkdown && !isValidNoteName(row.name)}
                                  >
                                    <span
                                      class="tree-row__dotted-badge"
                                      aria-hidden="true"
                                    >
                                      {" "}
                                      ⚠
                                    </span>
                                  </Show>
                                </span>
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
                <div class="vault-switcher-anchor">
                  <button
                    type="button"
                    class="vault-btn"
                    onClick={() => setVaultSwitcherOpen((v) => !v)}
                    disabled={busy()}
                    aria-haspopup="dialog"
                    aria-expanded={vaultSwitcherOpen()}
                    title="Switch vault"
                  >
                    <span class="vault-btn__name">
                      {vaultPath()?.split("/").filter(Boolean).pop() ?? "vault"}
                    </span>
                    <span class="vault-btn__caret">⌄</span>
                  </button>
                  <Show when={vaultSwitcherOpen()}>
                    <VaultSwitcher
                      currentPath={vaultPath()}
                      recentVaults={recentVaults().filter(
                        (v) => v.path !== vaultPath(),
                      )}
                      onSwitch={(path) => void openVaultByPath(path)}
                      onRemove={(path) =>
                        void removeRecentVault({ path }).then(refreshRecentVaults)
                      }
                      onOpenFolder={() => void handleOpen()}
                      onDismiss={() => setVaultSwitcherOpen(false)}
                    />
                  </Show>
                </div>
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
                    typedEnabled={typedProps()}
                    dateDefault={dateDefault()}
                    currencyDefault={currencyDefault()}
                    tagsKeyAsTags={tagsKeyAsTags()}
                  />
                </Show>
                <Editor
                  value={selectedContent() ?? ""}
                  resolvedTheme={resolvedTheme()}
                  rawSource={effectiveRaw()}
                  minimapEnabled={minimapEnabled()}
                  colorizeSource={colorizeSource()}
                  wikilinkResolver={wikilinkResolver()}
                  embedResolver={embedResolver()}
                  propertyResolver={propertyResolver()}
                  propertyRefsEnabled={corePluginEnabled(
                    corePlugins(),
                    CORE_PLUGINS.find((p) => p.id === "property-refs")!,
                  )}
                  dataviewRunner={
                    corePluginEnabled(
                      corePlugins(),
                      CORE_PLUGINS.find((p) => p.id === "dataview")!,
                    )
                      ? dataviewRunner()
                      : null
                  }
                  openNotePath={selectedPath()}
                  autocompleteProvider={autocompleteProvider()}
                  editorBindings={effectiveBindings()}
                  onNavigateWikilink={(path, anchor) =>
                    void handleNavigateWikilink(path, anchor)
                  }
                  onOfferCreateWikilink={(path) =>
                    handleOfferCreateWikilink(path)
                  }
                  onAnchorNotFound={notifyAnchorNotFound}
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
        onRunCommand={handleRunCommand}
      />

      <Show when={settingsOpen()}>
        <div
          class="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => {
            setSettingsOpen(false);
            setOpenInfo(null);
          }}
        >
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <Show when={openInfo() !== null}>
              <div
                class="set-info-backdrop"
                onClick={() => setOpenInfo(null)}
              />
            </Show>
            <button
              type="button"
              class="chrome-btn modal__close"
              aria-label="Close settings"
              onClick={() => {
                setSettingsOpen(false);
                setOpenInfo(null);
              }}
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
                    { id: "wikilinks", label: "🔗 Wiki links" },
                    { id: "plugins", label: "🧩 Plugins" },
                    { id: "statusbar", label: "📊 Status bar" },
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
                    onClick={() => {
                      setSettingsTab(t.id);
                      setOpenInfo(null);
                    }}
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
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Minimap</div>
                    <div class="set-row__desc">
                      Show a document overview strip beside the editor.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": !minimapEnabled(),
                      }}
                      onClick={() => setMinimapEnabledValue(false)}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": minimapEnabled(),
                      }}
                      onClick={() => setMinimapEnabledValue(true)}
                    >
                      On
                    </button>
                  </div>
                </div>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Colorize raw source</div>
                    <div class="set-row__desc">
                      In Raw Source mode, tint wiki-links, links and tags with
                      rendered-mode colors. Nothing is hidden or rendered — only
                      colors change.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": !colorizeSource(),
                      }}
                      onClick={() => setColorizeSourceValue(false)}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": colorizeSource(),
                      }}
                      onClick={() => setColorizeSourceValue(true)}
                    >
                      On
                    </button>
                  </div>
                </div>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Typed properties</div>
                    <div class="set-row__desc">
                      Give frontmatter properties a type (number, currency,
                      date &amp; time, list, …) for type-aware editors.
                    </div>
                  </div>
                  <div class="set-row__control">
                    <InfoButton id="typed-props">
                      <p style={{ margin: "0 0 var(--space-1) 0" }}>
                        <strong>How it works.</strong> Pick a type from the{" "}
                        <code>▾</code> menu on any property row. The Properties
                        panel then shows the right editor — a <code>$</code>{" "}
                        field for currency, a date picker, a dropdown for an
                        enum, and so on. The type is saved as a plain comment{" "}
                        <em>inside the note</em>, so it travels with the file and
                        any tool can read it. Nothing is stored outside the
                        vault.
                      </p>

                      <div
                        style={{
                          display: "grid",
                          "grid-template-columns": "auto 1fr",
                          "column-gap": "var(--space-2)",
                          "row-gap": "var(--space-1)",
                          "align-items": "baseline",
                          margin: "var(--space-2) 0",
                        }}
                      >
                        <For
                          each={
                            [
                              ["# type:text", "Text."],
                              ["# type:int", "Whole number."],
                              ["# type:float", "Decimal number."],
                              [
                                "# type:float/currency/usd",
                                "Currency — usd · nis · eur (symbol only; value stays a number).",
                              ],
                              ["# type:boolean", "True / false toggle."],
                              [
                                "# type:enum(alive,dead)",
                                "One of a fixed set of values.",
                              ],
                              [
                                "# type:date",
                                "A date. Formats: YYYY-MM-DD, YYYY-MM-DD HH:MM, YYYY, DD-MM-YYYY, MM/DD/YYYY, … — e.g. # type:date:DD-MM-YY.",
                              ],
                              [
                                "# type:list",
                                "A list of strings; items starting with # become clickable tags.",
                              ],
                            ] as [string, string][]
                          }
                        >
                          {([token, desc]) => (
                            <>
                              <code
                                style={{
                                  "font-family": "var(--font-mono)",
                                  "font-size": "var(--text-xs)",
                                  color: "var(--c-accent)",
                                  "white-space": "nowrap",
                                }}
                              >
                                {token}
                              </code>
                              <span style={{ "font-size": "var(--text-xs)" }}>
                                {desc}
                              </span>
                            </>
                          )}
                        </For>
                      </div>

                      <p style={{ margin: "0 0 var(--space-1) 0" }}>
                        Example frontmatter:
                      </p>
                      <pre
                        style={{
                          margin: "0 0 var(--space-1) 0",
                          padding: "var(--space-2)",
                          "font-family": "var(--font-mono)",
                          "font-size": "var(--text-xs)",
                          background: "var(--c-bg-primary)",
                          border: "1px solid var(--c-border-subtle)",
                          "border-radius": "var(--radius-sm)",
                          "white-space": "pre-wrap",
                        }}
                      >{`---
name: Ann       # type:text
price: 9.99     # type:float/currency/eur
status: alive   # type:enum(alive,dead)
meeting: 2026-06-17 14:30  # type:date:YYYY-MM-DD HH:MM
topics:         # type:list
  - "#draft"
---`}</pre>
                      <p style={{ margin: 0 }}>
                        A date using the default format, or a currency using the
                        default code, is written without the extra detail — only
                        a different one is written inline. Turning this off
                        leaves any existing <code># type:</code> comments
                        untouched.
                      </p>
                    </InfoButton>
                    <div class="seg-control">
                      <button
                        type="button"
                        class="seg-control__btn"
                        classList={{ "seg-control__btn--active": !typedProps() }}
                        onClick={() => setTypedPropsValue(false)}
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        class="seg-control__btn"
                        classList={{ "seg-control__btn--active": typedProps() }}
                        onClick={() => setTypedPropsValue(true)}
                      >
                        On
                      </button>
                    </div>
                  </div>
                </div>
                <Show when={typedProps()}>
                  <div class="set-row">
                    <div>
                      <div class="set-row__lab">Default date format</div>
                      <div class="set-row__desc">
                        Applied to every date property; override per-property
                        from the type menu.
                      </div>
                    </div>
                    <select
                      value={dateDefault()}
                      onChange={(e) =>
                        setDateDefaultValue(e.currentTarget.value)
                      }
                    >
                      <For each={DATE_FORMAT_TOKENS}>
                        {(token) => <option value={token}>{token}</option>}
                      </For>
                    </select>
                  </div>
                  <div class="set-row">
                    <div>
                      <div class="set-row__lab">Default currency</div>
                      <div class="set-row__desc">
                        Applied to currency properties; override per-property
                        from the type menu.
                      </div>
                    </div>
                    <select
                      value={currencyDefault()}
                      onChange={(e) =>
                        setCurrencyDefaultValue(e.currentTarget.value)
                      }
                    >
                      <For each={CURRENCY_CODES}>
                        {(code) => (
                          <option value={code}>{code.toUpperCase()}</option>
                        )}
                      </For>
                    </select>
                  </div>
                  <div class="set-row">
                    <div>
                      <div class="set-row__lab">Render “tags” as tags</div>
                      <div class="set-row__desc">
                        Show the <code>tags</code> property's list as tag chips
                        even when items don't start with <code>#</code>.
                      </div>
                    </div>
                    <div class="seg-control">
                      <button
                        type="button"
                        class="seg-control__btn"
                        classList={{
                          "seg-control__btn--active": !tagsKeyAsTags(),
                        }}
                        onClick={() => setTagsKeyAsTagsValue(false)}
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        class="seg-control__btn"
                        classList={{
                          "seg-control__btn--active": tagsKeyAsTags(),
                        }}
                        onClick={() => setTagsKeyAsTagsValue(true)}
                      >
                        On
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>
              <Show when={settingsTab() === "wikilinks"}>
                <h2 class="modal__h2">Wiki links</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">
                      Repair broken links on rename
                    </div>
                    <div class="set-row__desc">
                      When you rename a file, also fix links that point at
                      its old name but had already broken (e.g. from an
                      earlier rename). Off limits a rename to links that
                      still resolve to the file.
                    </div>
                  </div>
                  <div class="set-row__control">
                    <InfoButton id="wiki-repair">
                      <p>
                        <strong>On:</strong> renaming a file also fixes links
                        that point at its old name but had already broken from
                        an earlier rename.
                      </p>
                      <p>
                        <strong>Off:</strong> a rename only updates links that
                        still resolve to the file.
                      </p>
                    </InfoButton>
                    <div class="seg-control">
                      <button
                        type="button"
                        class="seg-control__btn"
                        classList={{
                          "seg-control__btn--active": !rewriteBrokenLinks(),
                        }}
                        onClick={() => setRewriteBrokenLinksValue(false)}
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        class="seg-control__btn"
                        classList={{
                          "seg-control__btn--active": rewriteBrokenLinks(),
                        }}
                        onClick={() => setRewriteBrokenLinksValue(true)}
                      >
                        On
                      </button>
                    </div>
                  </div>
                </div>
              </Show>
              <Show when={settingsTab() === "plugins"}>
                <h2 class="modal__h2">Core Plugins</h2>
                <For each={CORE_PLUGINS}>
                  {(p) => {
                    const on = () => corePlugins()[p.id] ?? p.defaultEnabled;
                    return (
                      <div class="set-row">
                        <div>
                          <div class="set-row__lab">{p.name}</div>
                          <div class="set-row__desc">{p.description}</div>
                        </div>
                        <div class="set-row__control">
                          <Show when={p.id === "dataview"}>
                            <InfoButton id="dataview">
                              <p>
                                A <code>query</code> block renders live results
                                from your vault as a table, list, or count — it
                                updates as notes change.
                              </p>
                              <pre>{'```query\nfrom #project where status = "active"\n```'}</pre>
                            </InfoButton>
                          </Show>
                          <Show when={p.id === "property-refs"}>
                            <InfoButton id="property-refs">
                              <p>
                                <code>[[note.prop]]</code> shows a value from
                                another note's frontmatter inline;{" "}
                                <code>[[.prop]]</code> reads the current note's
                                own.
                              </p>
                              <pre>{"# In Ann.md\n---\nrole: Engineer\n---\n\n# In any note\nAnn is a [[Ann.role]]."}</pre>
                            </InfoButton>
                          </Show>
                          <div class="seg-control">
                            <button
                              type="button"
                              class="seg-control__btn"
                              classList={{ "seg-control__btn--active": !on() }}
                              onClick={() =>
                                setCorePlugin(p.id, p.settingKey, false)
                              }
                            >
                              Off
                            </button>
                            <button
                              type="button"
                              class="seg-control__btn"
                              classList={{ "seg-control__btn--active": on() }}
                              onClick={() =>
                                setCorePlugin(p.id, p.settingKey, true)
                              }
                            >
                              On
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
              <Show when={settingsTab() === "statusbar"}>
                <h2 class="modal__h2">Status bar</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Show status bar</div>
                    <div class="set-row__desc">
                      The bar along the bottom. When off, it disappears entirely.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": !statusbarEnabled(),
                      }}
                      onClick={() =>
                        setStatusbarSetting(STATUSBAR_ENABLED_KEY, false)
                      }
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": statusbarEnabled(),
                      }}
                      onClick={() =>
                        setStatusbarSetting(STATUSBAR_ENABLED_KEY, true)
                      }
                    >
                      On
                    </button>
                  </div>
                </div>
                <For each={STATUSBAR_SEGMENTS}>
                  {(seg) => {
                    const on = () => segVisible(seg);
                    return (
                      <div
                        class="set-row"
                        style={{
                          opacity: statusbarEnabled() ? 1 : 0.5,
                          "pointer-events": statusbarEnabled() ? "auto" : "none",
                        }}
                      >
                        <div>
                          <div class="set-row__lab">{seg.name}</div>
                          <div class="set-row__desc">{seg.description}</div>
                        </div>
                        <div class="seg-control">
                          <button
                            type="button"
                            class="seg-control__btn"
                            classList={{ "seg-control__btn--active": !on() }}
                            onClick={() =>
                              setStatusbarSetting(seg.settingKey, false)
                            }
                          >
                            Off
                          </button>
                          <button
                            type="button"
                            class="seg-control__btn"
                            classList={{ "seg-control__btn--active": on() }}
                            onClick={() =>
                              setStatusbarSetting(seg.settingKey, true)
                            }
                          >
                            On
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
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
                <div
                  class="set-row__control"
                  style={{ "justify-content": "flex-end", "margin-bottom": "var(--space-2)" }}
                >
                  <InfoButton id="shortcuts">
                    <p>
                      Click <strong>Change</strong> on any row, then press the
                      key combination you want. Escape cancels; a combo
                      already used in the same scope is rejected. New in this
                      release: follow the link under the cursor (Alt+Enter),
                      toggle the left sidebar (⌘/Ctrl+Shift+L), new note
                      (⌘/Ctrl+N), and navigate back/forward
                      (⌘/Ctrl+Alt+←/→).
                    </p>
                  </InfoButton>
                </div>
                <ShortcutsPanel
                  overrides={shortcutOverrides()}
                  onChange={setShortcutOverridesValue}
                />
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

      <Show when={vaultId() && statusbarEnabled()}>
        <footer class="statusbar">
          {/* left: vault dir + system status (alerts always render when active) */}
          {(() => {
            const vaultVis = () => segVisible(VAULT_PATH_SEGMENT);
            const scanVis = () => scanStatus() === "in_progress";
            const brokenVis = () => !!formatBrokenBlockRefs(brokenBlockRefs());
            const pendingVis = () =>
              !!formatPendingRewrites(pendingRewritesCount());
            const sep = () =>
              leadingSeparators([
                vaultVis(),
                scanVis(),
                brokenVis(),
                pendingVis(),
              ]);
            return (
              <span class="statusbar__group statusbar__group--proj">
                <Show when={vaultVis()}>
                  <span class="statusbar__dir" title={vaultPath() ?? ""}>
                    {vaultPath() ?? vaultId()}
                  </span>
                </Show>
                <Show when={scanVis()}>
                  <Show when={sep()[1]}>
                    <span class="statusbar__sep">·</span>
                  </Show>
                  <span>
                    Scanning… {filesProcessed()} / {filesTotalEstimate()}
                  </span>
                </Show>
                <Show when={formatBrokenBlockRefs(brokenBlockRefs())}>
                  {(display) => (
                    <>
                      <Show when={sep()[2]}>
                        <span class="statusbar__sep">·</span>
                      </Show>
                      <span
                        title={display().title}
                        style={{ color: "var(--c-warning, var(--c-accent))" }}
                      >
                        {display().label}
                      </span>
                    </>
                  )}
                </Show>
                <Show when={sep()[3]}>
                  <span class="statusbar__sep">·</span>
                </Show>
                <PendingRewrites
                  vaultId={vaultId()}
                  count={pendingRewritesCount()}
                  onError={(m: string) => showToast(m)}
                />
              </span>
            );
          })()}

          {/* middle: current file info */}
          <Show when={view().kind === "file" && !!selectedPath()}>
            {(() => {
              const wordVis = () => segVisible(WORD_COUNT_SEGMENT);
              const blockVis = () => segVisible(BLOCK_COUNT_SEGMENT);
              const sep = () => leadingSeparators([wordVis(), blockVis()]);
              return (
                <span class="statusbar__group statusbar__mid">
                  <Show when={wordVis()}>
                    <b>{wordCount()}</b> words
                  </Show>
                  <Show when={blockVis()}>
                    <Show when={sep()[1]}>
                      <span class="statusbar__sep">·</span>
                    </Show>
                    <b>{blockCount()}</b> blocks
                  </Show>
                </span>
              );
            })()}
          </Show>

          {/* right: current file dir (vault-relative path) */}
          <span class="statusbar__group statusbar__group--file">
            <Show
              when={
                view().kind === "file" &&
                selectedPath() &&
                segVisible(FILE_PATH_SEGMENT)
              }
            >
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
              <Show when={menu().kind !== "file"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const parentDir = menu().path;
                    setContextMenu(null);
                    void handleContextMenuNewFile(parentDir);
                  }}
                  style={contextMenuItemStyle}
                >
                  New File
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const parentDir = menu().path;
                    setContextMenu(null);
                    void handleContextMenuNewFolder(parentDir);
                  }}
                  style={contextMenuItemStyle}
                >
                  New Folder
                </button>
              </Show>
              <Show when={menu().kind !== "empty"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const path = menu().path;
                    setContextMenu(null);
                    setRenamingPath(path);
                  }}
                  style={contextMenuItemStyle}
                >
                  Rename…
                </button>
              </Show>
              <Show when={menu().kind !== "empty"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const path = menu().path;
                    const kind = menu().kind === "folder" ? "folder" : "file";
                    setContextMenu(null);
                    handleRequestDelete(path, kind);
                  }}
                  style={{ ...contextMenuItemStyle, color: "var(--c-error)" }}
                >
                  Delete…
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>

      <Show when={deleteTarget()}>
        {(target) => (
          <div
            class="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm delete"
            style={{ "z-index": 30 }}
            onClick={() => !deleteInFlight() && setDeleteTarget(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(24rem, 90vw)",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-lg, var(--radius-md))",
                "box-shadow": "var(--shadow-lg, var(--shadow-md))",
                padding: "var(--space-4)",
                display: "flex",
                "flex-direction": "column",
                gap: "var(--space-3)",
              }}
            >
              <p
                style={{
                  margin: 0,
                  "font-size": "var(--text-sm)",
                  color: "var(--c-fg-primary)",
                }}
              >
                {target().kind === "folder"
                  ? `Delete "${target().path}" and its ${target().fileCount} file${
                      target().fileCount === 1 ? "" : "s"
                    }?`
                  : `Delete "${target().path}"?`}
              </p>
              <div
                style={{
                  display: "flex",
                  "justify-content": "flex-end",
                  gap: "var(--space-2)",
                }}
              >
                <button
                  type="button"
                  disabled={deleteInFlight()}
                  onClick={() => setDeleteTarget(null)}
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    background: "transparent",
                    border: "1px solid var(--c-border-subtle)",
                    "border-radius": "var(--radius-md)",
                    color: "var(--c-fg-primary)",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-sm)",
                    cursor: deleteInFlight() ? "default" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleteInFlight()}
                  onClick={() => void handleConfirmDelete()}
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    background: "var(--c-error)",
                    border: "none",
                    "border-radius": "var(--radius-md)",
                    color: "white",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-sm)",
                    cursor: deleteInFlight() ? "default" : "pointer",
                  }}
                >
                  {deleteInFlight() ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <ToastHost />
    </div>
  );
};

export default App;
