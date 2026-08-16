import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Match,
  Show,
  Switch,
  untrack,
  type Component,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Menu, { type MenuItem } from "@ds/components/overlay/Menu/Menu";
import Modal from "@ds/components/overlay/Modal/Modal";
import Icon from "@ds/components/graphics/Icon/Icon";

import Editor, { type EditorApi } from "./Editor";
import {
  TERMINAL_COMMAND_ID,
  TerminalButton,
  TerminalCloseDialog,
  TerminalConsentDialog,
  TerminalPanel,
  createTerminalWiring,
  isTerminalView,
  terminalTabIds,
} from "./terminal";
import Properties from "./Properties";
import { RecentVaultList } from "./RecentVaultList";
import SettingsModal from "./settings/SettingsModal";
import { createSettingsState } from "./settings/settingsState";
import type { CanonicalDocument, Frontmatter } from "./ast/types";
import {
  createBlockRef,
  createFileAtPath,
  getBrokenBlockRefs,
  listFiles,
  listRecentVaults,
  listTags,
  loadTabSession,
  saveTabSession,
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
  type BrokenBlockRef,
  type FileEntry,
  type RecentVault,
  type ResolvedAnchor,
  type TabSessionDto,
} from "./api/ipc";
import { createVaultSession } from "./core/vaultSession";
import { resolveGlobal, type Command } from "./core/commands";
import { createNavSession } from "./core/navSession";
import { createDebounced } from "./core/debounce";
import { createDocumentSession } from "./core/documentSession";
import TabStrip from "./tabs/TabStrip";
import {
  FileViewer,
  hasViewer,
  isEditableText,
  supportsSourceView,
  viewerKindForPath,
} from "./viewer";
import {
  activeTab,
  closeTab,
  dropMissingTabs,
  emptyTabs,
  isPersistableTab,
  moveTab,
  nextTab,
  openTab,
  prevTab,
  remapTabPaths,
  tabId,
  type TabSet,
  type TabView,
} from "./tabs/tabModel";
import { activateWithFlush, type ActivationDeps } from "./tabs/activation";
import { liveFileIds, touch } from "./tabs/lru";
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
import { createDataviewRunner, type DataviewRunner } from "./editor/dataview";
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
} from "./explorer/fileTree";
import { createFileActions } from "./explorer/fileActions";
import { buildBlockRefLink } from "./editor/blockRef";
import { formatBrokenBlockRefs } from "./statusbar/brokenRefs";
import { formatPendingRewrites } from "./statusbar/pendingRewritesLabel";
import PendingRewrites from "./statusbar/PendingRewrites";
import {
  VAULT_PATH_SEGMENT,
  FILE_PATH_SEGMENT,
  WORD_COUNT_SEGMENT,
  BLOCK_COUNT_SEGMENT,
} from "./statusbar/segments";
import { leadingSeparators } from "./statusbar/separators";
import { ToastHost } from "./ToastHost";
import { showToast } from "./toastState";
import { reprefixNestedPath, validateRenameTarget } from "./fileRename";
import { watchSystemTheme } from "./styles/theme";
import Backlinks from "./sidebar/Backlinks";
import UnlinkedMentions from "./sidebar/UnlinkedMentions";
import SearchPanel from "./sidebar/SearchPanel";
import IntegrityPanel from "./sidebar/IntegrityPanel";
import TagPage from "./TagPage";
import OmniBar from "./omnibar/OmniBar";
import { type OmniItem, type RankedItem } from "./omnibar/ranker";
import { OMNI_COMMANDS } from "./omnibar/commands";
import { corePluginOn } from "./settings/corePlugins";
import { VaultSwitcher } from "./VaultSwitcher";

const AUTOSAVE_DEBOUNCE_MS = 300;

const FILE_ROW_HEIGHT = 32;
const FILE_LIST_OVERSCAN = 8;

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
  const settings = createSettingsState({ vaultId });
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
  const [contents, setContents] = createStore<Record<string, string>>({});
  const selectedContent = (): string | null => {
    const id = tabs().activeId;
    return id === null ? null : (contents[id] ?? null);
  };
  const setSelectedContent = (value: string | null) => {
    const id = tabs().activeId;
    if (id === null) return;
    if (value === null) setContents(produce((c) => delete c[id]));
    else setContents(id, value);
  };
  interface DocSummary {
    frontmatter: Frontmatter | null;
    blocks: number;
    words: number;
  }
  const [docSummaries, setDocSummaries] = createStore<
    Record<string, DocSummary>
  >({});
  const activeSummary = (): DocSummary | undefined => {
    const id = tabs().activeId;
    return id === null ? undefined : docSummaries[id];
  };
  const propertiesFrontmatter = () => activeSummary()?.frontmatter ?? null;
  const blockCount = () => activeSummary()?.blocks ?? 0;
  const wordCount = () => activeSummary()?.words ?? 0;

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

  const [wikilinkResolver, setWikilinkResolver] =
    createSignal<WikiLinkResolver | null>(null);

  const [embedResolver, setEmbedResolver] = createSignal<EmbedResolver | null>(
    null,
  );

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

  const [leftCollapsed, setLeftCollapsed] = createSignal(false);
  const toggleLeftSidebar = () => setLeftCollapsed((v) => !v);
  const nav = createNavSession();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [vaultSwitcherOpen, setVaultSwitcherOpen] = createSignal(false);
  const [rightSidebarRefreshTick, setRightSidebarRefreshTick] = createSignal(0);
  const RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS = 200;
  const rightSidebarRefresh = createDebounced(
    () => setRightSidebarRefreshTick((n) => n + 1),
    RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS,
  );

  const [searchRefreshTick, setSearchRefreshTick] = createSignal(0);
  const searchRefresh = createDebounced(
    () => setSearchRefreshTick((n) => n + 1),
    250,
  );

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

  const [brokenBlockRefs, setBrokenBlockRefs] = createSignal<BrokenBlockRef[]>(
    [],
  );

  const [pendingRewritesCount, setPendingRewritesCount] = createSignal(0);
  const fileActions = createFileActions({
    vaultId,
    refreshFileList: () => refreshFileList(),
    openCreatedFile: (path, contentHash) =>
      handleNavigateWikilink(path, null, contentHash),
    reportError: setError,
    countFilesUnderFolder: (path) =>
      countFilesUnderFolder(buildFileTree(files(), folders()), path),
  });

  const [mru, setMru] = createSignal<string[]>([]);
  const editorApis = new Map<string, EditorApi>();
  // A path the editor can hold: markdown, or a plain-text file the engine
  // will write back. Everything else belongs to the read-only viewer.
  const isEditablePath = (p: string) => !hasViewer(p) || isEditableText(p);
  const live = () =>
    liveFileIds(mru(), tabs().activeId, settings.liveTabLimit(), (id) => {
      const p = pathForId(id);
      return p !== null && isEditablePath(p);
    });
  // Plain text hands off to the editor in source mode; the viewer keeps it
  // read-only otherwise.
  const viewerPath = createMemo(() => {
    const path = selectedPath();
    if (path === null || !vaultId() || !hasViewer(path)) return null;
    if (isEditableText(path) && settings.effectiveRaw()) return null;
    return path;
  });
  const sourceViewAvailable = createMemo(() => {
    const p = viewerPath();
    return p === null || supportsSourceView(viewerKindForPath(p));
  });
  const viewerEntry = (): FileEntry | undefined => {
    const path = viewerPath();
    return path === null ? undefined : files().find((f) => f.path === path);
  };
  const editorApi = (): EditorApi | undefined => {
    const id = tabs().activeId;
    return id === null ? undefined : editorApis.get(id);
  };
  const pathForId = (id: string): string | null => {
    const t = tabs().tabs.find((x) => x.id === id);
    return t !== undefined && t.view.kind === "file" ? t.view.path : null;
  };
  const [tabsReady, setTabsReady] = createSignal(false);

  const toDto = (s: TabSet): TabSessionDto => ({
    active_id: s.activeId,
    tabs: s.tabs.filter(isPersistableTab).map((t) => ({
      id: t.id,
      kind: t.view.kind,
      path: t.view.kind === "file" ? t.view.path : null,
      tag_path: t.view.kind === "tag" ? t.view.tagPath : null,
    })),
  });

  const fromDto = (dto: TabSessionDto): TabSet => {
    const tabs = dto.tabs.flatMap((r) => {
      const view: TabView | null =
        r.kind === "file" && r.path !== null
          ? { kind: "file", path: r.path }
          : r.kind === "tag" && r.tag_path !== null
            ? { kind: "tag", tagPath: r.tag_path }
            : null;
      return view === null ? [] : [{ id: tabId(view), view }];
    });
    const activeId = tabs.some((t) => t.id === dto.active_id)
      ? dto.active_id
      : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  };

  const restoreTabs = async (path: string) => {
    try {
      const dto = await loadTabSession(path);
      let restored = fromDto(dto);
      if (scanStatus() === "complete") {
        const present = new Set(files().map((f) => f.path));
        restored = dropMissingTabs(restored, (p) => present.has(p));
      }
      if (restored.tabs.length > 0) {
        setTabs(restored);
        await loadActiveTabContent();
      }
    } catch (e) {
      console.error("loadTabSession failed", e);
    } finally {
      setTabsReady(true);
    }
  };

  createEffect(() => {
    const path = vaultPath();
    const ready = tabsReady();
    const snapshot = toDto(tabs());
    if (path === null || !ready) return;
    void saveTabSession(path, snapshot);
  });

  createEffect(() => {
    const id = tabs().activeId;
    if (id !== null) setMru((m) => touch(m, id));
  });

  createEffect(() => {
    const open = new Set(tabs().tabs.map((t) => t.id));
    setMru((m) =>
      m.every((id) => open.has(id)) ? m : m.filter((id) => open.has(id)),
    );
    untrack(() => {
      const stale = Object.keys(docSummaries).filter((id) => !open.has(id));
      if (stale.length === 0) return;
      setDocSummaries(
        produce((s: Record<string, DocSummary>) => {
          for (const id of stale) delete s[id];
        }),
      );
    });
  });

  createEffect(() => {
    const keep = new Set(live());
    for (const id of [...editorApis.keys()]) {
      if (!keep.has(id)) editorApis.delete(id);
    }
    untrack(() => {
      for (const id of Object.keys(contents)) {
        if (!keep.has(id)) setContents(produce((c) => delete c[id]));
      }
    });
  });

  const doc = createDocumentSession({
    vaultId,
    path: selectedPath,
    editor: editorApi,
    autosaveDebounceMs: AUTOSAVE_DEBOUNCE_MS,
    reportError: setError,
    onWritten: () => searchRefresh.schedule(),
    onContentReplaced: (content) => setSelectedContent(content),
  });
  const flushAutosave = () => doc.flush();

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
      if (scanStatus() === "complete") {
        const present = new Set(resp.files.map((f) => f.path));
        const dropped = dropMissingTabs(tabs(), (p) => present.has(p));
        if (dropped !== tabs()) {
          const before = tabs().activeId;
          setTabs(dropped);
          setMru((m) =>
            m.filter((mid) => dropped.tabs.some((t) => t.id === mid)),
          );
          if (dropped.activeId !== before) {
            resetDocState();
            if (dropped.activeId !== null) await loadActiveTabContent();
          }
        }
      }
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

  const brokenBlockRefsRefresh = createDebounced(
    () => void refreshBrokenBlockRefs(),
    RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS,
  );

  const handleRenameCommit = async (
    fromPath: string,
    rawTarget: string,
    isFolder = false,
  ): Promise<void> => {
    const id = vaultId();
    if (!id) {
      fileActions.startRename(null);
      return;
    }
    const validation = validateRenameTarget(fromPath, rawTarget, isFolder);
    if (validation !== null) {
      if (validation.code !== "same") {
        showToast(validation.message);
      }
      fileActions.startRename(null);
      return;
    }
    const target = rawTarget.trim();
    fileActions.startRename(null);
    try {
      if (isFolder) {
        await renameFolder({
          vault_id: id,
          from_path: fromPath,
          to_path: target,
        });
      } else {
        await renameFile({
          vault_id: id,
          from_path: fromPath,
          to_path: target,
        });
      }
      const renamedId = (oldId: string): string => {
        if (!oldId.startsWith("file:")) return oldId;
        const p = oldId.slice("file:".length);
        const to = isFolder
          ? reprefixNestedPath(p, fromPath, target)
          : p === fromPath
            ? target
            : null;
        return to === null || to === p
          ? oldId
          : tabId({ kind: "file", path: to });
      };
      setTabs((s) =>
        remapTabPaths(s, (p) =>
          isFolder
            ? reprefixNestedPath(p, fromPath, target)
            : p === fromPath
              ? target
              : null,
        ),
      );
      setMru((m) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const id of m) {
          const next = renamedId(id);
          if (!seen.has(next)) {
            seen.add(next);
            out.push(next);
          }
        }
        return out;
      });
      setContents(
        produce((c) => {
          for (const oldId of Object.keys(c)) {
            const next = renamedId(oldId);
            if (next === oldId) continue;
            if (!(next in c)) c[next] = c[oldId]!;
            delete c[oldId];
          }
        }),
      );
      wikilinkResolver()?.invalidate();
      embedResolver()?.invalidate();
      propertyResolver()?.invalidate();
      dataviewRunner()?.invalidate();
      void refreshFileList();
      rightSidebarRefresh.schedule();
    } catch (e) {
      const message = errorMessage(e);
      showToast(message);
    }
  };

  // Markdown titles are shown stem-only and get .md reattached. A plain-text
  // file carries its extension in the title, so it renames to what was typed —
  // reattaching .md would turn notes.txt into notes.txt.md.
  const titleValue = (path: string) =>
    path.endsWith(".md") ? fileStem(path) : (path.split("/").pop() ?? path);

  const commitTitleRename = (fromPath: string, typed: string) => {
    const name = typed.trim();
    if (!name) return;
    const slash = fromPath.lastIndexOf("/");
    const dir = slash >= 0 ? fromPath.slice(0, slash + 1) : "";
    const target = fromPath.endsWith(".md")
      ? `${dir}${name}.md`
      : `${dir}${name}`;
    if (target === fromPath) return;
    void handleRenameCommit(fromPath, target);
  };

  const renameTarget = (fromPath: string, basename: string) => {
    const i = fromPath.lastIndexOf("/");
    const dir = i >= 0 ? fromPath.slice(0, i + 1) : "";
    return dir + basename.trim();
  };

  const handleContentChange = (_content: string) => {
    doc.markDirty();
    doc.scheduleWrite();
  };

  const handleAstChange = (tabIdOfDoc: string, doc: CanonicalDocument) => {
    const text =
      editorApis.get(tabIdOfDoc)?.getContent() ?? contents[tabIdOfDoc] ?? "";
    const trimmed = text.trim();
    setDocSummaries(tabIdOfDoc, {
      frontmatter: doc.frontmatter,
      blocks: doc.blocks.length,
      words: trimmed ? trimmed.split(/\s+/).length : 0,
    });
  };

  // Leaving source mode unmounts the editor for a plain-text file, so any edit
  // still inside the autosave debounce has to land before the mode flips.
  const withRawFlush = (apply: () => void) => {
    const path = selectedPath();
    if (path === null || !isEditableText(path)) {
      apply();
      return;
    }
    void flushAutosave().then(apply);
  };

  const toggleRawSource = () => {
    if (!sourceViewAvailable()) return;
    const next = !settings.effectiveRaw();
    withRawFlush(() => settings.setRawOverride(next));
  };

  const setRawAsDefault = () => {
    const next = !settings.effectiveRaw();
    withRawFlush(() => settings.setRawDefaultValue(next));
  };

  const handleRunCommand = (id: string) => {
    if (id === "statusbar.toggle") settings.toggleStatusbar();
  };

  const loadActiveTabContent = async () => {
    const id = vaultId();
    const path = selectedPath();
    if (!id || path === null) return;
    if (!isEditablePath(path)) return;
    try {
      const resp = await readFileText({ vault_id: id, path });
      setSelectedContent(resp.content);
    } catch (e) {
      setError(errorMessage(e));
      setSelectedContent(null);
    }
  };

  const resetDocState = () => {
    setError(null);
    settings.setRawOverride(null);
    doc.reset();
  };

  const activationDeps: ActivationDeps = {
    current: () => tabs(),
    flush: () => flushAutosave(),
    setTabs: (fn) => setTabs(fn),
    resetDocState,
    loadContent: () => loadActiveTabContent(),
  };

  const activateTabById = async (
    id: string,
    opts?: { fromHistory?: boolean },
  ) => {
    const switching = tabs().activeId !== id;
    await activateWithFlush(activationDeps, id);
    if (!switching || opts?.fromHistory === true) return;
    const t = activeTab(tabs());
    if (t === null || t.view.kind !== "file") return;
    const path = t.view.path;
    nav.push(path);
  };

  const closeTabById = async (id: string) => {
    if (!(await terminalTab.confirmClose(id))) return;
    await forceCloseTabById(id);
  };

  const forceCloseTabById = async (id: string) => {
    const wasActive = tabs().activeId === id;
    if (wasActive) await flushAutosave();
    setTabs((s) => closeTab(s, id));
    setMru((m) => m.filter((x) => x !== id));
    if (!wasActive) return;
    resetDocState();
    if (tabs().activeId !== null) await loadActiveTabContent();
  };

  const terminalTab = createTerminalWiring({
    vaultId,
    corePlugins: settings.corePlugins,
    tabs,
    setTabs: (updater) => setTabs(updater),
    closeTab: (id) => forceCloseTabById(id),
    flushAutosave: () => flushAutosave(),
  });

  const handleSelectFile = async (
    file: FileEntry,
    knownHash?: string,
    opts?: { fromHistory?: boolean },
  ) => {
    const isMarkdown = file.type_id === "markdown";
    if (!isMarkdown && !hasViewer(file.path)) return;
    const id = vaultId();
    if (!id) return;
    if (selectedPath() === file.path) return;

    await flushAutosave();

    resetDocState();
    setTabs((s) => openTab(s, { kind: "file", path: file.path }));
    if (!opts?.fromHistory) nav.push(file.path);
    if (!isMarkdown && !isEditableText(file.path)) return;
    doc.adopt(knownHash ?? null);
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
    const path = nav.back();
    if (path) navigateToHistoryPath(path);
  };
  const goForward = () => {
    const path = nav.forward();
    if (path) navigateToHistoryPath(path);
  };

  const reloadFromDisk = () => doc.takeDisk();

  const keepMyEdits = () => doc.keepMine();

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
      editorApi()?.requestAnchorScroll(anchor);
    }
    await handleSelectFile(file, knownHash);
    if (anchor !== null && alreadyOpen) {
      const found =
        anchor.kind === "heading"
          ? editorApi()?.scrollToHeading(anchor.value)
          : editorApi()?.scrollToBlock(anchor.value);
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
    const back = nav.current();
    const target = back === null ? null : tabId({ kind: "file", path: back });
    const canRestore =
      target !== null &&
      target !== id &&
      tabs().tabs.some((t) => t.id === target);
    if (!canRestore) {
      await closeTabById(id);
      return;
    }
    await activateTabById(target, { fromHistory: true });
    setTabs((s) => closeTab(s, id));
    setMru((m) => m.filter((x) => x !== id));
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
          fileActions.closeContextMenu();
          void fileActions.newFileInTree(menu.path);
        },
      });
      items.push({
        id: "new-folder",
        label: "New Folder",
        onSelect: () => {
          fileActions.closeContextMenu();
          void fileActions.newFolderInTree(menu.path);
        },
      });
    }
    if (menu.kind !== "empty") {
      items.push({
        id: "rename",
        label: "Rename…",
        onSelect: () => {
          fileActions.closeContextMenu();
          fileActions.startRename(menu.path);
        },
      });
      items.push({
        id: "delete",
        label: "Delete…",
        danger: true,
        onSelect: () => {
          const kind = menu.kind === "folder" ? "folder" : "file";
          fileActions.closeContextMenu();
          fileActions.requestDelete(menu.path, kind);
        },
      });
    }
    return items;
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

      const ownWrite = doc.isOwnWriteEchoOf(p.path, p.new_content_hash);
      if (!ownWrite) {
        wikilinkResolver()?.invalidate();
        embedResolver()?.invalidate();
        propertyResolver()?.invalidate();
        dataviewRunner()?.invalidate();
      }

      rightSidebarRefresh.schedule();

      searchRefresh.schedule();

      brokenBlockRefsRefresh.schedule();

      if (view().kind === "tag") {
        setTagRefreshTick((n) => n + 1);
      }

      doc.applyExternalChange(p.path, p.new_content_hash);
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
      void settings.hydrate(p.vault_id);
    });

    const onBeforeUnload = () => doc.writeBeforeUnload();
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
        run: () => void fileActions.newFile(""),
      },
      "nav.back": {
        id: "nav.back",
        title: "Navigate back",
        when: () => nav.canBack(),
        run: () => goBack(),
      },
      "nav.forward": {
        id: "nav.forward",
        title: "Navigate forward",
        when: () => nav.canForward(),
        run: () => goForward(),
      },
      "view.nextTab": {
        id: "view.nextTab",
        title: "Next tab",
        when: () => tabs().tabs.length > 1,
        run: () => {
          const id = nextTab(tabs()).activeId;
          if (id !== null) void activateTabById(id);
        },
      },
      "view.prevTab": {
        id: "view.prevTab",
        title: "Previous tab",
        when: () => tabs().tabs.length > 1,
        run: () => {
          const id = prevTab(tabs()).activeId;
          if (id !== null) void activateTabById(id);
        },
      },
      "view.closeTab": {
        id: "view.closeTab",
        title: "Close tab",
        when: () => tabs().activeId !== null,
        run: () => {
          const id = tabs().activeId;
          if (id !== null) void closeTabById(id);
        },
      },
      [TERMINAL_COMMAND_ID]: terminalTab.command,
    };
    const onGlobalKey = (e: KeyboardEvent) => {
      const c = resolveGlobal(settings.effectiveBindings(), globalCommands, e);
      if (!c) return;
      e.preventDefault();
      c.run();
    };
    window.addEventListener("keydown", onGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", onGlobalKey));

    const unwatchTheme = watchSystemTheme(() => {
      settings.reapplySystemTheme();
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
    doc.cancelScheduledWrite();
    rightSidebarRefresh.cancel();
    searchRefresh.cancel();
    brokenBlockRefsRefresh.cancel();
  });

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
      setTabsReady(false);
      setTabs(emptyTabs);
      setContents(
        produce((c) => {
          for (const k of Object.keys(c)) delete c[k];
        }),
      );
      setMru([]);
      nav.reset();
      doc.reset();
      setDocSummaries(
        produce((s: Record<string, DocSummary>) => {
          for (const k of Object.keys(s)) delete s[k];
        }),
      );
      setCreateOffer(null);
      setRightSidebarRefreshTick(0);
      setBrokenBlockRefs([]);
      setPendingRewritesCount(0);
      fileActions.reset();
      setTagRefreshTick(0);
      settings.resetForVaultSwitch();
      setWikilinkResolver(null);
      setEmbedResolver(null);
      setPropertyResolver(null);
      setDataviewRunner(null);
      setAutocompleteProvider(null);

      const resp = await openVault({ path });
      setVaultId(resp.vault_id);
      setScanStatus(resp.scan_status);
      setWikilinkResolver(createWikiLinkResolver(resp.vault_id));
      setEmbedResolver(createEmbedResolver(resp.vault_id));
      setPropertyResolver(createPropertyResolver(resp.vault_id));
      setDataviewRunner(
        createDataviewRunner(
          resp.vault_id,
          (p) => void handleNavigateWikilink(p, null),
        ),
      );
      setAutocompleteProvider(createAutocompleteProvider(resp.vault_id));
      scheduleRefresh();

      await settings.hydrate(resp.vault_id);
      await refreshFileList();
      await restoreTabs(path);

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
            disabled={!nav.canBack()}
          >
            ‹
          </IconButton>
          <IconButton
            label="Navigate forward"
            onClick={goForward}
            disabled={!nav.canForward()}
          >
            ›
          </IconButton>
          <TerminalButton
            available={terminalTab.available}
            onOpen={terminalTab.open}
            view={view}
          />
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
              active={settings.effectiveRaw() && sourceViewAvailable()}
              ariaPressed={settings.effectiveRaw() && sourceViewAvailable()}
              disabled={!sourceViewAvailable()}
              onClick={(e) =>
                e.shiftKey ? setRawAsDefault() : toggleRawSource()
              }
              title={
                !sourceViewAvailable()
                  ? "This file has no source view"
                  : settings.effectiveRaw()
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
            onClick={settings.toggleRightSidebar}
            ariaPressed={!settings.rightSidebarCollapsed()}
          >
            {settings.rightSidebarCollapsed() ? "⟨" : "⟩"}
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
                      onClick={() => void fileActions.newFile("")}
                      style={{ "font-size": "var(--text-sm)" }}
                    >
                      <Icon name="plus" />
                    </IconButton>
                    <IconButton
                      label="New folder"
                      size="sm"
                      disabled={!vaultId()}
                      onClick={() => void fileActions.newFolder("")}
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
                    fileActions.openContextMenu({
                      kind: "empty",
                      path: "",
                      x: e.clientX,
                      y: e.clientY,
                    });
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
                              const isRenamingFolder = () =>
                                fileActions.renamingPath() === row.path;
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
                                    fileActions.openContextMenu({
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
                                      <span class="tree-row__name">
                                        {row.name}
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
                                            renameTarget(
                                              row.path,
                                              e.currentTarget.value,
                                            ),
                                            true,
                                          );
                                        } else if (e.key === "Escape") {
                                          e.preventDefault();
                                          fileActions.startRename(null);
                                        }
                                      }}
                                      onBlur={(e) =>
                                        void handleRenameCommit(
                                          row.path,
                                          renameTarget(
                                            row.path,
                                            e.currentTarget.value,
                                          ),
                                          true,
                                        )
                                      }
                                    />
                                  </Show>
                                </div>
                              );
                            }
                            const isMarkdown = row.typeId === "markdown";
                            const isUnsupported =
                              !isMarkdown && !hasViewer(row.path);
                            const isSelected = () =>
                              selectedPath() === row.path;
                            const isRenaming = () =>
                              fileActions.renamingPath() === row.path;
                            const parts = () => splitFileName(row.name);
                            return (
                              <div
                                class="tree-row tree-row--file"
                                classList={{
                                  "tree-row--selected": isSelected(),
                                  "tree-row--unsupported": isUnsupported,
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
                                  fileActions.openContextMenu({
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
                                          isMarkdown &&
                                          !isValidNoteName(row.name),
                                        "tree-row__name--unsupported":
                                          isUnsupported,
                                      }}
                                      title={
                                        isMarkdown && !isValidNoteName(row.name)
                                          ? noteNameError(row.name)
                                          : isUnsupported
                                            ? `Cubical has no viewer for .${splitFileName(row.name).ext} files — the file is untouched on disk.`
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
                                        when={
                                          isMarkdown &&
                                          !isValidNoteName(row.name)
                                        }
                                      >
                                        <span
                                          class="tree-row__dotted-badge"
                                          aria-hidden="true"
                                        >
                                          {" "}
                                          <Icon name="warning" />
                                        </span>
                                      </Show>
                                      <Show when={isUnsupported}>
                                        <span
                                          class="tree-row__unsupported-badge"
                                          aria-label="Unsupported file"
                                          role="img"
                                        >
                                          {" "}
                                          <Icon name="info" />
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
                                          renameTarget(
                                            row.path,
                                            e.currentTarget.value,
                                          ),
                                        );
                                      } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        fileActions.startRename(null);
                                      }
                                    }}
                                    onBlur={(e) =>
                                      void handleRenameCommit(
                                        row.path,
                                        renameTarget(
                                          row.path,
                                          e.currentTarget.value,
                                        ),
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
                        void removeRecentVault({ path }).then(
                          refreshRecentVaults,
                        )
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
                <Show when={!isTerminalView(view())}>
                  <Show
                    when={view().kind === "file"}
                    fallback={
                      <TagPage
                        vaultId={vaultId()}
                        tagPath={
                          (view() as { kind: "tag"; tagPath: string }).tagPath
                        }
                        refreshSignal={tagRefreshTick()}
                        onSelectFile={(path) =>
                          void handleNavigateWikilink(path, null)
                        }
                        onBack={handleExitTagView}
                      />
                    }
                  >
                    <Show
                      when={viewerPath()}
                      keyed
                      fallback={
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
                              Select a file to open it.
                            </div>
                          }
                        >
                          <Show when={selectedPath()} keyed>
                            {(path) => (
                              <input
                                class="doc-title"
                                aria-label="File name"
                                spellcheck={false}
                                // Only note names are renameable here:
                                // isValidNoteName rejects every dotted name.
                                readOnly={!path.endsWith(".md")}
                                value={titleValue(path)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    e.currentTarget.value = titleValue(path);
                                    e.currentTarget.blur();
                                  }
                                }}
                                onBlur={(e) =>
                                  commitTitleRename(path, e.currentTarget.value)
                                }
                              />
                            )}
                          </Show>
                          <Show when={doc.conflictHash() !== null}>
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
                              <span>
                                This file was changed outside Cubical.
                              </span>
                              <span
                                style={{
                                  display: "flex",
                                  gap: "var(--space-2)",
                                }}
                              >
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
                                    "border-radius":
                                      "var(--radius-sm, var(--radius-md))",
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
                                    "border-radius":
                                      "var(--radius-sm, var(--radius-md))",
                                    cursor: "pointer",
                                  }}
                                >
                                  Keep my edits
                                </button>
                              </span>
                            </div>
                          </Show>
                          <Show when={!settings.effectiveRaw()}>
                            <Properties
                              frontmatter={propertiesFrontmatter()}
                              path={selectedPath() ?? ""}
                              getSource={() => editorApi()?.getContent() ?? ""}
                              applyEdit={(from, to, text) =>
                                editorApi()?.replaceRange(from, to, text)
                              }
                              onOpenRaw={() => settings.setRawOverride(true)}
                              onNavigateTag={(tagPath) =>
                                void handleNavigateTag(tagPath)
                              }
                              typedEnabled={settings.typedProps()}
                              dateDefault={settings.dateDefault()}
                              currencyDefault={settings.currencyDefault()}
                              tagsKeyAsTags={settings.tagsKeyAsTags()}
                            />
                          </Show>
                          <For each={live()}>
                            {(id) => (
                              <div
                                style={{
                                  display:
                                    id === tabs().activeId
                                      ? "contents"
                                      : "none",
                                }}
                              >
                                <Editor
                                  value={contents[id] ?? ""}
                                  resolvedTheme={settings.resolvedTheme()}
                                  rawSource={settings.effectiveRaw()}
                                  minimapEnabled={settings.minimapEnabled()}
                                  colorizeSource={settings.colorizeSource()}
                                  wikilinkResolver={wikilinkResolver()}
                                  embedResolver={embedResolver()}
                                  propertyResolver={propertyResolver()}
                                  propertyRefsEnabled={corePluginOn(
                                    settings.corePlugins(),
                                    "property-refs",
                                  )}
                                  mathEnabled={corePluginOn(
                                    settings.corePlugins(),
                                    "math",
                                  )}
                                  dataviewRunner={
                                    corePluginOn(
                                      settings.corePlugins(),
                                      "dataview",
                                    )
                                      ? dataviewRunner()
                                      : null
                                  }
                                  openNotePath={pathForId(id)}
                                  autocompleteProvider={autocompleteProvider()}
                                  editorBindings={settings.effectiveBindings()}
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
                                  onAstChange={(doc) =>
                                    handleAstChange(id, doc)
                                  }
                                  onContentChange={handleContentChange}
                                  onBlur={() => void flushAutosave()}
                                  onCopyBlockRef={(off) =>
                                    void handleCopyBlockRef(off)
                                  }
                                  ref={(api) => editorApis.set(id, api)}
                                />
                              </div>
                            )}
                          </For>
                        </Show>
                      }
                    >
                      {(path) => (
                        <FileViewer
                          vaultId={vaultId()!}
                          path={path}
                          sizeBytes={viewerEntry()?.size_bytes ?? 0}
                          mtimeUnix={viewerEntry()?.mtime_unix ?? 0}
                          rawSource={settings.effectiveRaw()}
                        />
                      )}
                    </Show>
                  </Show>
                </Show>
                <For each={terminalTabIds(tabs().tabs)}>
                  {(id) => (
                    <div
                      style={{
                        display: id === tabs().activeId ? "contents" : "none",
                      }}
                    >
                      <TerminalPanel
                        vaultId={vaultId()!}
                        resolvedTheme={settings.resolvedTheme()}
                        onOpened={(terminalId) =>
                          terminalTab.register(id, terminalId)
                        }
                        onClosed={() => terminalTab.forget(id)}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </main>
          <aside
            class="side side--right"
            classList={{ "side--collapsed": settings.rightSidebarCollapsed() }}
          >
            <div class="side__body">
              <div role="tablist" aria-label="Sidebar panels" class="rs-tabs">
                <button
                  type="button"
                  role="tab"
                  aria-selected={settings.rightSidebarPanel() === "backlinks"}
                  class="rs-tab"
                  classList={{
                    "rs-tab--active":
                      settings.rightSidebarPanel() === "backlinks",
                  }}
                  onClick={() =>
                    settings.setRightSidebarPanelValue("backlinks")
                  }
                >
                  Backlinks
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={
                    settings.rightSidebarPanel() === "unlinked_mentions"
                  }
                  class="rs-tab"
                  classList={{
                    "rs-tab--active":
                      settings.rightSidebarPanel() === "unlinked_mentions",
                  }}
                  onClick={() =>
                    settings.setRightSidebarPanelValue("unlinked_mentions")
                  }
                >
                  Mentions
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settings.rightSidebarPanel() === "integrity"}
                  class="rs-tab"
                  classList={{
                    "rs-tab--active":
                      settings.rightSidebarPanel() === "integrity",
                  }}
                  onClick={() =>
                    settings.setRightSidebarPanelValue("integrity")
                  }
                >
                  Integrity
                </button>
              </div>
              <div class="rs-body">
                <Switch>
                  <Match when={settings.rightSidebarPanel() === "backlinks"}>
                    <Backlinks
                      vaultId={vaultId()}
                      path={selectedPath()}
                      refreshSignal={rightSidebarRefreshTick()}
                      onRowClick={(path) =>
                        void handleNavigateWikilink(path, null)
                      }
                    />
                  </Match>
                  <Match
                    when={settings.rightSidebarPanel() === "unlinked_mentions"}
                  >
                    <UnlinkedMentions
                      vaultId={vaultId()}
                      path={selectedPath()}
                      refreshSignal={rightSidebarRefreshTick()}
                      onRowClick={(path) =>
                        void handleNavigateWikilink(path, null)
                      }
                    />
                  </Match>
                  <Match when={settings.rightSidebarPanel() === "integrity"}>
                    <IntegrityPanel
                      vaultId={vaultId()}
                      refreshSignal={rightSidebarRefreshTick()}
                      onRowClick={(path) =>
                        void handleNavigateWikilink(path, null)
                      }
                      onRepaired={() => rightSidebarRefresh.schedule()}
                    />
                  </Match>
                </Switch>
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

      <SettingsModal
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        vaultPath={vaultPath()}
        busy={busy()}
        onOpenAnotherVault={() => void handleOpen()}
      />

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
              <Button
                variant="secondary"
                size="sm"
                onClick={dismissCreateOffer}
              >
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

      <Show when={vaultId() && settings.statusbarEnabled()}>
        <footer class="statusbar">
          {(() => {
            const vaultVis = () => settings.segVisible(VAULT_PATH_SEGMENT);
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
              const wordVis = () => settings.segVisible(WORD_COUNT_SEGMENT);
              const blockVis = () => settings.segVisible(BLOCK_COUNT_SEGMENT);
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
                settings.segVisible(FILE_PATH_SEGMENT)
              }
            >
              <span class="statusbar__dir" title={selectedPath() ?? ""}>
                {selectedPath()}
              </span>
            </Show>
          </span>
        </footer>
      </Show>

      <Show when={fileActions.contextMenu()}>
        {(menu) => (
          <>
            <div
              onClick={() => fileActions.closeContextMenu()}
              onContextMenu={(e) => {
                e.preventDefault();
                fileActions.closeContextMenu();
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

      <Show when={fileActions.deleteTarget()}>
        {(target) => (
          <Modal
            open={true}
            size="sm"
            placement="center"
            ariaLabel="Confirm delete"
            onClose={() => {
              if (!fileActions.deleteInFlight()) fileActions.cancelDelete();
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
                  disabled={fileActions.deleteInFlight()}
                  onClick={() => fileActions.cancelDelete()}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={fileActions.deleteInFlight()}
                  onClick={() => void fileActions.confirmDelete()}
                >
                  {fileActions.deleteInFlight() ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </Show>

      <TerminalConsentDialog
        prompt={terminalTab.consentPrompt}
        onAccept={terminalTab.acceptConsent}
        onDecline={terminalTab.declineConsent}
      />

      <TerminalCloseDialog
        tabId={terminalTab.busyTabId}
        onAnswer={terminalTab.answerBusyClose}
      />

      <ToastHost />
    </div>
  );
};

export default App;
