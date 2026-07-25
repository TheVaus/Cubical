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

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Select from "@ds/components/forms/Select/Select";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";
import Menu, { type MenuItem } from "@ds/components/overlay/Menu/Menu";
import Modal from "@ds/components/overlay/Modal/Modal";
import TwoPaneModal from "@ds/components/overlay/TwoPaneModal/TwoPaneModal";
import Popover from "@ds/components/overlay/Popover/Popover";
import Icon, { type IconName } from "@ds/components/graphics/Icon/Icon";

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
  onVaultSettingChanged,
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
import TabStrip from "./tabs/TabStrip";
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  moveTab,
  openTab,
  remapTabPaths,
  tabId,
  type TabSet,
  type TabView,
} from "./tabs/tabModel";
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

const AUTOSAVE_DEBOUNCE_MS = 300;

const FILE_ROW_HEIGHT = 32;
const FILE_LIST_OVERSCAN = 8;

const THEME_ICON: Record<ThemeMode, IconName> = {
  system: "settings",
  light: "sun",
  dark: "moon",
};

type SettingsTab =
  | "appearance"
  | "editor"
  | "wikilinks"
  | "plugins"
  | "statusbar"
  | "vault"
  | "shortcuts";

const SETTINGS_TABS: { id: SettingsTab; icon: IconName; label: string }[] = [
  { id: "appearance", icon: "palette", label: "Appearance" },
  { id: "editor", icon: "file-text", label: "Editor" },
  { id: "wikilinks", icon: "link", label: "Wiki links" },
  { id: "plugins", icon: "puzzle", label: "Plugins" },
  { id: "statusbar", icon: "bar-chart", label: "Status bar" },
  { id: "vault", icon: "library", label: "Vault" },
  { id: "shortcuts", icon: "keyboard", label: "Shortcuts" },
];

const App: Component = () => {
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
  const [booting, setBooting] = createSignal(true);
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
  const [selectedContent, setSelectedContent] = createSignal<string | null>(
    null,
  );
  const [propertiesFrontmatter, setPropertiesFrontmatter] =
    createSignal<Frontmatter | null>(null);

  const [blockCount, setBlockCount] = createSignal(0);
  const [wordCount, setWordCount] = createSignal(0);

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(600);
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

  const [themeMode, setThemeMode] = createSignal<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>(
    applyTheme("system"),
  );

  const [rawDefault, setRawDefault] = createSignal(false);
  const [rawOverride, setRawOverride] = createSignal<boolean | null>(null);
  const [minimapEnabled, setMinimapEnabled] = createSignal(false);
  const [colorizeSource, setColorizeSource] = createSignal(false);
  const effectiveRaw = createMemo(() =>
    resolveRawState(rawOverride(), rawDefault()),
  );

  const [rewriteBrokenLinks, setRewriteBrokenLinks] = createSignal(true);
  const setRewriteBrokenLinksValue = (val: boolean) => {
    setRewriteBrokenLinks(val);
    persistSetting(
      vaultId(),
      "wikilinks.rewrite_broken_links_on_rename",
      val,
    );
  };

  const [typedProps, setTypedProps] = createSignal(false);
  const [dateDefault, setDateDefault] = createSignal("YYYY-MM-DD");
  const [currencyDefault, setCurrencyDefault] = createSignal("usd");
  const [tagsKeyAsTags, setTagsKeyAsTags] = createSignal(true);

  const [conflictExternalHash, setConflictExternalHash] = createSignal<
    string | null
  >(null);

  const [wikilinkResolver, setWikilinkResolver] =
    createSignal<WikiLinkResolver | null>(null);

  const [embedResolver, setEmbedResolver] =
    createSignal<EmbedResolver | null>(null);

  const [propertyResolver, setPropertyResolver] =
    createSignal<PropertyResolver | null>(null);

  const [dataviewRunner, setDataviewRunner] =
    createSignal<DataviewRunner | null>(null);

  const [autocompleteProvider, setAutocompleteProvider] =
    createSignal<AutocompleteProvider | null>(null);

  const [createOffer, setCreateOffer] = createSignal<{ path: string } | null>(
    null,
  );

  type View = TabView;
  const [tabs, setTabs] = createSignal<TabSet>(emptyTabs);
  const view = (): View =>
    activeTab(tabs())?.view ?? { kind: "file", path: "" };
  const selectedPath = (): string | null => {
    const t = activeTab(tabs());
    return t !== null && t.view.kind === "file" ? t.view.path : null;
  };
  const [tagRefreshTick, setTagRefreshTick] = createSignal(0);

  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(false);
  const [leftCollapsed, setLeftCollapsed] = createSignal(false);
  const toggleLeftSidebar = () => setLeftCollapsed((v) => !v);
  const [navState, setNavState] = createSignal<NavState>(emptyNav);
  const navCanBack = createMemo(() => canBack(navState()));
  const navCanForward = createMemo(() => canForward(navState()));
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = createSignal(false);
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
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("appearance");
  const [openInfo, setOpenInfo] = createSignal<InfoId | null>(null);
  const flipInfo = (id: InfoId) => setOpenInfo((cur) => toggleInfo(cur, id));
  const [corePlugins, setCorePlugins] = createSignal<Record<string, boolean>>({});
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

  const [omniOpen, setOmniOpen] = createSignal(false);
  const [vaultTags, setVaultTags] = createSignal<string[]>([]);
  const [tagsLoaded, setTagsLoaded] = createSignal(false);

  const fileStem = (path: string) => {
    const base = path.split("/").pop() ?? path;
    return base.endsWith(".md") ? base.slice(0, -3) : base;
  };

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
  createEffect(
    on(
      () => searchRefreshTick(),
      () => {
        setTagsLoaded(false);
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

  type RightSidebarPanel = "backlinks" | "unlinked_mentions";
  const [rightSidebarPanel, setRightSidebarPanel] =
    createSignal<RightSidebarPanel>("backlinks");

  const [brokenBlockRefs, setBrokenBlockRefs] = createSignal<BrokenBlockRef[]>(
    [],
  );
  let brokenBlockRefsTimer: ReturnType<typeof setTimeout> | undefined;

  const [pendingRewritesCount, setPendingRewritesCount] = createSignal(0);
  const [contextMenu, setContextMenu] = createSignal<{
    kind: "file" | "folder" | "empty";
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

  let seenHash: string | null = null;
  let lastWrittenHash: string | null = null;
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
  let unlistenSettingChanged: UnlistenFn | undefined;

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
      if (editorApi.getContent() === content) {
        dirty = false;
      }
      scheduleSearchRefresh();
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
    }
  };

  const flushAutosave = async (): Promise<void> => {
    if (autosaveTimer !== undefined) {
      clearTimeout(autosaveTimer);
      autosaveTimer = undefined;
    }
    if (!dirty && pendingWrite === null) return;
    const prior = pendingWrite ?? Promise.resolve();
    const next = prior.then(performWrite);
    pendingWrite = next;
    try {
      await next;
    } finally {
      if (pendingWrite === next) pendingWrite = null;
    }
  };

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
      return;
    }
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined;
      void flushAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const scheduleRightSidebarRefresh = () => {
    if (rightSidebarRefreshTimer !== undefined) {
      clearTimeout(rightSidebarRefreshTimer);
    }
    rightSidebarRefreshTimer = setTimeout(() => {
      rightSidebarRefreshTimer = undefined;
      setRightSidebarRefreshTick((n) => n + 1);
    }, RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS);
  };

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

  const scheduleBrokenBlockRefsRefresh = () => {
    if (brokenBlockRefsTimer !== undefined) {
      clearTimeout(brokenBlockRefsTimer);
    }
    brokenBlockRefsTimer = setTimeout(() => {
      brokenBlockRefsTimer = undefined;
      void refreshBrokenBlockRefs();
    }, RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS);
  };

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
      setTabs((s) =>
        remapTabPaths(s, (p) =>
          isFolder
            ? reprefixNestedPath(p, fromPath, target)
            : p === fromPath
              ? target
              : null,
        ),
      );
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

  const commitTitleRename = (fromPath: string, newStem: string) => {
    const stem = newStem.trim();
    if (!stem) return;
    const slash = fromPath.lastIndexOf("/");
    const dir = slash >= 0 ? fromPath.slice(0, slash + 1) : "";
    const target = `${dir}${stem}.md`;
    if (target === fromPath) return;
    void handleRenameCommit(fromPath, target);
  };

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

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setResolvedTheme(applyTheme(mode));
    persistSetting(vaultId(), "appearance.theme_mode", mode);
  };

  const toggleRawSource = () => {
    setRawOverride(!effectiveRaw());
  };

  const setRawAsDefault = () => {
    const next = !effectiveRaw();
    setRawDefault(next);
    setRawOverride(null);
    persistSetting(vaultId(), "editor.raw_source_default", next);
  };

  const setRawDefaultValue = (val: boolean) => {
    setRawDefault(val);
    setRawOverride(null);
    persistSetting(vaultId(), "editor.raw_source_default", val);
  };

  const setMinimapEnabledValue = (val: boolean) => {
    setMinimapEnabled(val);
    persistSetting(vaultId(), "editor.minimap_enabled", val);
  };

  const setColorizeSourceValue = (val: boolean) => {
    setColorizeSource(val);
    persistSetting(vaultId(), "editor.colorize_raw_source", val);
  };

  const setTypedPropsValue = (val: boolean) => {
    setTypedProps(val);
    persistSetting(vaultId(), "properties.typed_enabled", val);
  };

  const setDateDefaultValue = (val: string) => {
    setDateDefault(val);
    persistSetting(vaultId(), "properties.date_format_default", val);
  };

  const setCurrencyDefaultValue = (val: string) => {
    setCurrencyDefault(val);
    persistSetting(vaultId(), "properties.default_currency", val);
  };

  const setTagsKeyAsTagsValue = (val: boolean) => {
    setTagsKeyAsTags(val);
    persistSetting(vaultId(), "properties.tags_key_as_tags", val);
  };

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

  const setStatusbarSetting = (key: BooleanSettingKey, value: boolean) => {
    const v = vaultId();
    if (!v) return;
    setStatusbarConfig((prev) => ({ ...prev, [key]: value }));
    persistSetting(v, key, value);
  };

  const handleRunCommand = (id: string) => {
    if (id === "statusbar.toggle") {
      setStatusbarSetting(STATUSBAR_ENABLED_KEY, !statusbarEnabled());
    }
  };

  const toggleRightSidebar = () => {
    const next = !rightSidebarCollapsed();
    setRightSidebarCollapsed(next);
    persistSetting(vaultId(), "ui.right_sidebar_collapsed", next);
  };

  const handleRightSidebarSegmentChange = (id: string) => {
    if (id !== "backlinks" && id !== "unlinked_mentions") return;
    setRightSidebarPanel(id);
    persistSetting(vaultId(), "ui.right_sidebar_panel", id);
  };

  const loadActiveTabContent = async () => {
    const id = vaultId();
    const path = selectedPath();
    if (!id || path === null) return;
    try {
      const resp = await readFileText({ vault_id: id, path });
      setSelectedContent(resp.content);
    } catch (e) {
      setError(errorMessage(e));
      setSelectedContent(null);
    }
  };

  const activateTabById = async (id: string) => {
    if (tabs().activeId === id) return;
    await flushAutosave();
    setError(null);
    setConflictExternalHash(null);
    setRawOverride(null);
    setPropertiesFrontmatter(null);
    seenHash = null;
    lastWrittenHash = null;
    dirty = false;
    setTabs((s) => activateTab(s, id));
    await loadActiveTabContent();
  };

  const closeTabById = async (id: string) => {
    const wasActive = tabs().activeId === id;
    if (wasActive) await flushAutosave();
    setTabs((s) => closeTab(s, id));
    if (!wasActive) return;
    setError(null);
    setConflictExternalHash(null);
    setRawOverride(null);
    setPropertiesFrontmatter(null);
    seenHash = null;
    lastWrittenHash = null;
    dirty = false;
    if (tabs().activeId === null) setSelectedContent(null);
    else await loadActiveTabContent();
  };

  const handleSelectFile = async (
    file: FileEntry,
    knownHash?: string,
    opts?: { fromHistory?: boolean },
  ) => {
    if (file.type_id !== "markdown") return;
    const id = vaultId();
    if (!id) return;
    if (selectedPath() === file.path) return;

    await flushAutosave();

    setError(null);
    setConflictExternalHash(null);
    setTabs((s) => openTab(s, { kind: "file", path: file.path }));
    if (!opts?.fromHistory) setNavState((s) => navPush(s, file.path));
    setRawOverride(null);
    setPropertiesFrontmatter(null);
    seenHash = knownHash ?? null;
    lastWrittenHash = knownHash ?? null;
    dirty = false;
    await loadActiveTabContent();
  };

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
    setConflictExternalHash(null);
    scheduleAutosave();
  };

  const handleNavigateWikilink = async (
    path: string,
    anchor: ResolvedAnchor | null,
    knownHash?: string,
  ) => {
    const id = vaultId();
    if (!id) return;
    const existing = files().find((f) => f.path === path);
    const file = existing ?? {
      path,
      type_id: "markdown",
      size_bytes: 0,
      mtime_unix: 0,
    };
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

  const notifyAnchorNotFound = (anchor: ResolvedAnchor) => {
    const what = anchor.kind === "heading" ? "Heading" : "Block";
    showToast(`${what} "${anchor.value}" not found in the linked note`);
  };

  const handleOfferCreateWikilink = (path: string) => {
    setCreateOffer({ path });
  };

  const handleNavigateTag = async (tagPath: string) => {
    await flushAutosave();
    setTabs((s) => openTab(s, { kind: "tag", tagPath }));
  };

  const handleExitTagView = async () => {
    const id = tabs().activeId;
    if (id === null) return;
    const back = navCurrent(navState());
    await closeTabById(id);
    if (back === null) return;
    const target = tabId({ kind: "file", path: back });
    if (tabs().tabs.some((t) => t.id === target)) await activateTabById(target);
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
      const resp = await createFileAtPath({ vault_id: id, path: offer.path });
      await handleNavigateWikilink(offer.path, null, resp.content_hash);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
    }
  };

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

  const handleRequestDelete = (path: string, kind: "file" | "folder") => {
    const fileCount =
      kind === "folder"
        ? countFilesUnderFolder(buildFileTree(files(), folders()), path)
        : 0;
    setDeleteTarget({ path, kind, fileCount });
  };

  const buildContextMenuItems = (menu: {
    kind: "file" | "folder" | "empty";
    path: string;
  }): MenuItem[] => {
    const items: MenuItem[] = [];
    if (menu.kind !== "file") {
      items.push({
        id: "new-file",
        label: "New File",
        onSelect: () => {
          setContextMenu(null);
          void handleContextMenuNewFile(menu.path);
        },
      });
      items.push({
        id: "new-folder",
        label: "New Folder",
        onSelect: () => {
          setContextMenu(null);
          void handleContextMenuNewFolder(menu.path);
        },
      });
    }
    if (menu.kind !== "empty") {
      items.push({
        id: "rename",
        label: "Rename…",
        onSelect: () => {
          setContextMenu(null);
          setRenamingPath(menu.path);
        },
      });
      items.push({
        id: "delete",
        label: "Delete…",
        danger: true,
        onSelect: () => {
          const kind = menu.kind === "folder" ? "folder" : "file";
          setContextMenu(null);
          handleRequestDelete(menu.path, kind);
        },
      });
    }
    return items;
  };

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

      const ownWrite = isOwnWriteEcho({
        changedPath: p.path,
        selectedPath: selectedPath(),
        incomingHash: p.new_content_hash,
        lastWrittenHash,
      });
      if (!ownWrite) {
        wikilinkResolver()?.invalidate();
        embedResolver()?.invalidate();
        propertyResolver()?.invalidate();
        dataviewRunner()?.invalidate();
      }

      scheduleRightSidebarRefresh();

      scheduleSearchRefresh();

      scheduleBrokenBlockRefsRefresh();

      if (view().kind === "tag") {
        setTagRefreshTick((n) => n + 1);
      }

      if (p.path !== selectedPath()) return;
      const incoming = p.new_content_hash;
      if (!incoming) return;

      if (incoming === lastWrittenHash) return;

      if (dirty || conflictExternalHash() !== null) {
        setConflictExternalHash(incoming);
        if (autosaveTimer !== undefined) {
          clearTimeout(autosaveTimer);
          autosaveTimer = undefined;
        }
      } else {
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
    unlistenSettingChanged = await onVaultSettingChanged((p) => {
      if (p.vault_id !== vaultId()) return;
      void hydrateVaultSettings(p.vault_id);
    });

    const onBeforeUnload = () => {
      if (autosaveTimer !== undefined) {
        clearTimeout(autosaveTimer);
        autosaveTimer = undefined;
      }
      if (dirty) void performWrite();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));

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

    const unwatchTheme = watchSystemTheme(() => {
      if (themeMode() === "system") setResolvedTheme(applyTheme("system"));
    });
    onCleanup(unwatchTheme);

    await refreshRecentVaults();
    const top = recentVaults()[0];
    if (top && top.exists) {
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
    unlistenSettingChanged?.();
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    if (rightSidebarRefreshTimer !== undefined)
      clearTimeout(rightSidebarRefreshTimer);
    if (searchRefreshTimer !== undefined) clearTimeout(searchRefreshTimer);
  });

  const hydrateVaultSettings = async (vid: string) => {
    try {
      const stored = await getSetting(vid, "appearance.theme_mode");
      if (stored !== null) {
        setThemeMode(stored);
        setResolvedTheme(applyTheme(stored));
      }
    } catch (e) {
      console.error("loading theme_mode failed", e);
    }

    await seedSetting(vid, "editor.raw_source_default", false, setRawDefault);

    await seedSetting(vid, "editor.minimap_enabled", false, setMinimapEnabled);

    await seedSetting(
      vid,
      "editor.colorize_raw_source",
      false,
      setColorizeSource,
    );

    await seedSetting(
      vid,
      "wikilinks.rewrite_broken_links_on_rename",
      true,
      setRewriteBrokenLinks,
    );
    await seedSetting(vid, "properties.typed_enabled", false, setTypedProps);
    await seedSetting(
      vid,
      "properties.date_format_default",
      "YYYY-MM-DD",
      setDateDefault,
    );
    await seedSetting(
      vid,
      "properties.default_currency",
      "usd",
      setCurrencyDefault,
    );
    await seedSetting(
      vid,
      "properties.tags_key_as_tags",
      true,
      setTagsKeyAsTags,
    );

    {
      const enab: Record<string, boolean> = {};
      for (const p of CORE_PLUGINS) {
        try {
          const stored = await getSetting(vid, p.settingKey);
          enab[p.id] = stored ?? p.defaultEnabled;
        } catch (e) {
          console.error(`loading ${p.settingKey} failed`, e);
          enab[p.id] = p.defaultEnabled;
        }
      }
      setCorePlugins(enab);
    }

    {
      const cfg: Record<string, boolean> = {};
      const keys: BooleanSettingKey[] = [
        STATUSBAR_ENABLED_KEY,
        ...STATUSBAR_SEGMENTS.map((s) => s.settingKey),
      ];
      for (const k of keys) {
        try {
          cfg[k] = (await getSetting(vid, k)) ?? STATUSBAR_DEFAULT;
        } catch (e) {
          console.error(`loading ${k} failed`, e);
          cfg[k] = STATUSBAR_DEFAULT;
        }
      }
      setStatusbarConfig(cfg);
    }

    await seedSetting(
      vid,
      "ui.right_sidebar_collapsed",
      false,
      setRightSidebarCollapsed,
    );

    await seedSetting(
      vid,
      "ui.right_sidebar_panel",
      "backlinks",
      setRightSidebarPanel,
    );

    await seedSetting(vid, "shortcuts.overrides", {}, setShortcutOverrides);
  };

  const openVaultByPath = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      setFiles([]);
      setFolders([]);
      setFilesProcessed(0);
      setFilesTotalEstimate(0);
      setScanStatus("in_progress");
      setVaultPath(path);
      setTabs(emptyTabs);
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

      await hydrateVaultSettings(resp.vault_id);

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

  const OnOffControl = (props: {
    value: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <SegmentedControl
      variant="pill"
      role="radiogroup"
      options={[
        { label: "Off", value: "off" },
        { label: "On", value: "on" },
      ]}
      value={props.value ? "on" : "off"}
      onChange={(v) => props.onChange(v === "on")}
    />
  );

  const InfoButton = (props: { id: InfoId; children: JSX.Element }) => (
    <>
      <button
        type="button"
        class="set-info-btn"
        aria-label="About this setting"
        aria-expanded={openInfo() === props.id}
        onClick={() => flipInfo(props.id)}
      >
        <Icon name="info" />
      </button>
      <Popover
        open={openInfo() === props.id}
        onClose={() => setOpenInfo(null)}
        ariaLabel="Setting help"
        placement="bottom-end"
        class="set-info-pop"
      >
        {props.children}
      </Popover>
    </>
  );

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar__flank topbar__flank--left">
          <IconButton
            label="Toggle file panel"
            onClick={toggleLeftSidebar}
            ariaPressed={!leftCollapsed()}
          >
            {leftCollapsed() ? "⟩" : "⟨"}
          </IconButton>
          <IconButton
            label="Navigate back"
            onClick={goBack}
            disabled={!navCanBack()}
          >
            ‹
          </IconButton>
          <IconButton
            label="Navigate forward"
            onClick={goForward}
            disabled={!navCanForward()}
          >
            ›
          </IconButton>
        </div>
        <div class="topbar__center">
          <TabStrip
            tabs={tabs()}
            onActivate={(id) => void activateTabById(id)}
            onClose={(id) => void closeTabById(id)}
            onMove={(id, i) => setTabs((s) => moveTab(s, id, i))}
          />
          <div class="topbar__source">
            <IconButton
              label="Toggle raw source"
              mono
              active={effectiveRaw()}
              ariaPressed={effectiveRaw()}
              onClick={(e) =>
                e.shiftKey ? setRawAsDefault() : toggleRawSource()
              }
              title={
                effectiveRaw()
                  ? "Raw source (Cmd/Ctrl+E · Shift-click sets default)"
                  : "Live preview (Cmd/Ctrl+E · Shift-click sets default)"
              }
            >
              &lt;/&gt;
            </IconButton>
          </div>
        </div>
        <div class="topbar__flank topbar__flank--right">
          <IconButton
            label="Toggle backlinks panel"
            onClick={toggleRightSidebar}
            ariaPressed={!rightSidebarCollapsed()}
          >
            {rightSidebarCollapsed() ? "⟨" : "⟩"}
          </IconButton>
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
          <Show when={!booting()}>
            <div class="empty-vault">
              <p>Pick a folder to open it as a vault.</p>
              <Button variant="primary" onClick={handleOpen} disabled={busy()}>
                Open Vault
              </Button>
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
                  <IconButton
                    label="New file"
                    size="sm"
                    disabled={!vaultId()}
                    onClick={() => void handleNewFile()}
                    style={{ "font-size": "var(--text-sm)" }}
                  >
                    <Icon name="plus" />
                  </IconButton>
                  <IconButton
                    label="New folder"
                    size="sm"
                    disabled={!vaultId()}
                    onClick={() => void handleNewFolder()}
                    style={{ "font-size": "var(--text-sm)" }}
                  >
                    <Icon name="folder-plus" />
                  </IconButton>
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
                                <Icon
                                  name={
                                    row.collapsed
                                      ? "chevron-right"
                                      : "chevron-down"
                                  }
                                  size={14}
                                />
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
                                      <Icon name="warning" />
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
                    <span class="vault-btn__caret">
                      <Icon name="chevron-down" size={14} />
                    </span>
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
                <IconButton
                  label="Settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Icon name="settings" />
                </IconButton>
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

      <TwoPaneModal
        open={settingsOpen()}
        onClose={() => {
          setSettingsOpen(false);
          setOpenInfo(null);
        }}
        title="Settings"
        items={SETTINGS_TABS}
        activeId={settingsTab()}
        onSelect={(id) => {
          setSettingsTab(id as SettingsTab);
          setOpenInfo(null);
        }}
      >
              <Show when={settingsTab() === "appearance"}>
                <h2 class="set-h2">Appearance</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Theme</div>
                    <div class="set-row__desc">
                      Follow the system, or force light / dark.
                    </div>
                  </div>
                  <SegmentedControl
                    variant="pill"
                    role="radiogroup"
                    options={(["system", "light", "dark"] as ThemeMode[]).map(
                      (m) => ({ label: m, value: m, icon: THEME_ICON[m] }),
                    )}
                    value={themeMode()}
                    onChange={(v) => setTheme(v as ThemeMode)}
                  />
                </div>
              </Show>
              <Show when={settingsTab() === "editor"}>
                <h2 class="set-h2">Editor</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">
                      Open notes in raw source by default
                    </div>
                    <div class="set-row__desc">
                      Otherwise notes open in Live Preview.
                    </div>
                  </div>
                  <OnOffControl
                    value={rawDefault()}
                    onChange={setRawDefaultValue}
                  />
                </div>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Minimap</div>
                    <div class="set-row__desc">
                      Show a document overview strip beside the editor.
                    </div>
                  </div>
                  <OnOffControl
                    value={minimapEnabled()}
                    onChange={setMinimapEnabledValue}
                  />
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
                  <OnOffControl
                    value={colorizeSource()}
                    onChange={setColorizeSourceValue}
                  />
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
                    <OnOffControl
                      value={typedProps()}
                      onChange={setTypedPropsValue}
                    />
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
                    <Select
                      options={DATE_FORMAT_TOKENS.map((t) => ({ value: t }))}
                      value={dateDefault()}
                      onChange={(v) => setDateDefaultValue(v)}
                      ariaLabel="Default date format"
                    />
                  </div>
                  <div class="set-row">
                    <div>
                      <div class="set-row__lab">Default currency</div>
                      <div class="set-row__desc">
                        Applied to currency properties; override per-property
                        from the type menu.
                      </div>
                    </div>
                    <Select
                      options={CURRENCY_CODES.map((c) => ({ value: c, label: c.toUpperCase() }))}
                      value={currencyDefault()}
                      onChange={(v) => setCurrencyDefaultValue(v)}
                      ariaLabel="Default currency"
                    />
                  </div>
                  <div class="set-row">
                    <div>
                      <div class="set-row__lab">Render “tags” as tags</div>
                      <div class="set-row__desc">
                        Show the <code>tags</code> property's list as tag chips
                        even when items don't start with <code>#</code>.
                      </div>
                    </div>
                    <OnOffControl
                      value={tagsKeyAsTags()}
                      onChange={setTagsKeyAsTagsValue}
                    />
                  </div>
                </Show>
              </Show>
              <Show when={settingsTab() === "wikilinks"}>
                <h2 class="set-h2">Wiki links</h2>
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
                    <OnOffControl
                      value={rewriteBrokenLinks()}
                      onChange={setRewriteBrokenLinksValue}
                    />
                  </div>
                </div>
              </Show>
              <Show when={settingsTab() === "plugins"}>
                <h2 class="set-h2">Core Plugins</h2>
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
                          <OnOffControl
                            value={on()}
                            onChange={(v) =>
                              setCorePlugin(p.id, p.settingKey, v)
                            }
                          />
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
              <Show when={settingsTab() === "statusbar"}>
                <h2 class="set-h2">Status bar</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Show status bar</div>
                    <div class="set-row__desc">
                      The bar along the bottom. When off, it disappears entirely.
                    </div>
                  </div>
                  <OnOffControl
                    value={statusbarEnabled()}
                    onChange={(v) =>
                      setStatusbarSetting(STATUSBAR_ENABLED_KEY, v)
                    }
                  />
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
                        <OnOffControl
                          value={on()}
                          onChange={(v) =>
                            setStatusbarSetting(seg.settingKey, v)
                          }
                        />
                      </div>
                    );
                  }}
                </For>
              </Show>
              <Show when={settingsTab() === "vault"}>
                <h2 class="set-h2">Vault</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Current vault</div>
                    <div class="set-row__desc">{vaultPath() ?? "—"}</div>
                  </div>
                  <Button
                    variant="primary"
                    onClick={handleOpen}
                    disabled={busy()}
                  >
                    Open another…
                  </Button>
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
      </TwoPaneModal>

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
              <Button variant="secondary" size="sm" onClick={dismissCreateOffer}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void acceptCreateOffer()}
              >
                Create note
              </Button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={vaultId() && statusbarEnabled()}>
        <footer class="statusbar">
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
              style={{
                position: "fixed",
                top: `${menu().y}px`,
                left: `${menu().x}px`,
                "z-index": 13,
              }}
            >
              <Menu items={buildContextMenuItems(menu())} />
            </div>
          </>
        )}
      </Show>

      <Show when={deleteTarget()}>
        {(target) => (
          <Modal
            open={true}
            size="sm"
            placement="center"
            ariaLabel="Confirm delete"
            onClose={() => {
              if (!deleteInFlight()) setDeleteTarget(null);
            }}
          >
            <div
              style={{
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
                <Button
                  variant="secondary"
                  disabled={deleteInFlight()}
                  onClick={() => setDeleteTarget(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={deleteInFlight()}
                  onClick={() => void handleConfirmDelete()}
                >
                  {deleteInFlight() ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </Show>

      <ToastHost />
    </div>
  );
};

export default App;
