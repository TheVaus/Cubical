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

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";
import ConfirmDialog from "@ds/components/overlay/ConfirmDialog/ConfirmDialog";

import Editor, { type EditorApi } from "./Editor";
import {
  TERMINAL_COMMAND_ID,
  TerminalButton,
  TerminalCloseDialog,
  TerminalConsentDialog,
  TerminalTabPanes,
  createTerminalWiring,
  isTerminalView,
} from "./terminal";
import { GRAPH_COMMAND_ID, GraphButton, GraphTabPane, createGraphWiring, isGraphView } from "./graph";
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
} from "./api/ipc";
import { createVaultSession } from "./core/vaultSession";
import { type Command } from "./core/commands";
import { attachGlobalKeys } from "./core/globalKeys";
import { createNavSession } from "./core/navSession";
import { createDebounced } from "./core/debounce";
import { createDocumentSession } from "./core/documentSession";
import { switchVault } from "./core/vaultOpen";
import { createListenerGroup } from "./core/listenerGroup";
import FeatureBoundary from "./core/FeatureBoundary";
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
  moveTab,
  nextTab,
  openTab,
  prevTab,
  remapTabPaths,
  tabId,
  type TabSet,
  type TabView,
} from "./tabs/tabModel";
import { fromTabSessionDto, toTabSessionDto } from "./tabs/session";
import { activateWithFlush, type ActivationDeps } from "./tabs/activation";
import { liveFileIds, touch } from "./tabs/lru";
import { pruneContents, remapContentKeys } from "./tabs/contentCache";
import { resetResolvers, revalidateResolvers } from "./editor/resolverRefresh";
import type { ResolverGroup } from "./editor/resolverRefresh";

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
import { createDataviewWiring } from "./editor/dataviewWiring";
import {
  createAutocompleteProvider,
  type AutocompleteProvider,
} from "./editor/autocompleteProvider";
import { buildFileTree, countFilesUnderFolder } from "./explorer/fileTree";
import { createFileActions } from "./explorer/fileActions";
import ExplorerPanel from "./explorer/ExplorerPanel";
import FileContextMenu from "./explorer/FileContextMenu";
import DeleteDialog from "./explorer/DeleteDialog";
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
import {
  renameTarget,
  reprefixNestedPath,
  validateRenameTarget,
} from "./fileRename";
import { noteTitle } from "./vault/noteName";
import { watchSystemTheme } from "./styles/theme";
import Backlinks from "./sidebar/Backlinks";
import UnlinkedMentions from "./sidebar/UnlinkedMentions";
import IntegrityPanel from "./sidebar/IntegrityPanel";
import TagPage from "./TagPage";
import OmniBar from "./omnibar/OmniBar";
import { type OmniItem, type RankedItem } from "./omnibar/ranker";
import { OMNI_COMMANDS } from "./omnibar/commands";
import { corePluginActive } from "./settings/corePlugins";
import { VaultSwitcher } from "./VaultSwitcher";

const AUTOSAVE_DEBOUNCE_MS = 300;

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
  const pluginOn = (id: string) => corePluginActive(settings.corePlugins(), id);
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

  const [wikilinkResolver, setWikilinkResolver] =
    createSignal<WikiLinkResolver | null>(null);

  const [embedResolver, setEmbedResolver] = createSignal<EmbedResolver | null>(
    null,
  );

  const [propertyResolver, setPropertyResolver] =
    createSignal<PropertyResolver | null>(null);

  const dataviewRunner = createDataviewWiring({
    vaultId,
    corePlugins: settings.corePlugins,
    onOpen: (p) => void handleNavigateWikilink(p, null),
  });

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
      .map((f) => ({ kind: "note", title: noteTitle(f.path), path: f.path }));
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
        item: { kind: "note" as const, title: noteTitle(f.path), path: f.path },
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

  const restoreTabs = async (path: string) => {
    try {
      const dto = await loadTabSession(path);
      let restored = fromTabSessionDto(dto);
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
    const snapshot = toTabSessionDto(tabs());
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
    untrack(() => pruneContents(setContents, contents, (id) => keep.has(id)));
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

  const vaultListeners = createListenerGroup();

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
      remapContentKeys(setContents, contents, renamedId);
      resetResolvers(resolvers());
      await doc.refreshFromDisk();
      void refreshFileList();
      rightSidebarRefresh.schedule();
    } catch (e) {
      const message = errorMessage(e);
      showToast(message);
    }
  };

  const commitTitleRename = (fromPath: string, typed: string) => {
    const name = typed.trim();
    if (!name) return;
    const target = renameTarget(
      fromPath,
      fromPath.endsWith(".md") ? `${name}.md` : name,
    );
    if (target === fromPath) return;
    void handleRenameCommit(fromPath, target);
  };

  const handleContentChange = (_content: string) => {
    doc.markDirty();
    doc.scheduleWrite();
  };

  const handleAstChange = (tabIdOfDoc: string, ast: CanonicalDocument) => {
    const text =
      editorApis.get(tabIdOfDoc)?.getContent() ?? contents[tabIdOfDoc] ?? "";
    const trimmed = text.trim();
    setDocSummaries(tabIdOfDoc, {
      frontmatter: ast.frontmatter,
      blocks: ast.blocks.length,
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

  const resolvers = (): ResolverGroup => ({
    wikilink: wikilinkResolver(),
    embed: embedResolver(),
    property: propertyResolver(),
    dataview: dataviewRunner(),
  });

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

  const tabFeature = {
    vaultId,
    corePlugins: settings.corePlugins,
    tabs,
    setTabs: (updater: (s: TabSet) => TabSet) => setTabs(updater),
    closeTab: (id: string) => forceCloseTabById(id),
    flushAutosave: () => flushAutosave(),
  };

  const terminalTab = createTerminalWiring(tabFeature);
  const graphTab = createGraphWiring(tabFeature);

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

  onMount(async () => {
    await vaultListeners.attach("vault:scan-progress", () =>
      onVaultScanProgress((p) => {
        if (p.vault_id !== vaultId()) return;
        setFilesProcessed(p.files_processed);
        setFilesTotalEstimate(p.files_total_estimate);
        scheduleRefresh();
      }),
    );
    await vaultListeners.attach("vault:scan-complete", () =>
      onVaultScanComplete((p) => {
        if (p.vault_id !== vaultId()) return;
        setFilesProcessed(p.file_count);
        setFilesTotalEstimate(p.file_count);
        setScanStatus("complete");
        void refreshFileList();
        void refreshBrokenBlockRefs();
      }),
    );
    await vaultListeners.attach("vault:scan-cancelled", () =>
      onVaultScanCancelled((p) => {
        if (p.vault_id !== vaultId()) return;
        setScanStatus("cancelled");
      }),
    );
    await vaultListeners.attach("vault:file-changed", () =>
      onVaultFileChanged((p) => {
        if (p.vault_id !== vaultId()) return;
        scheduleRefresh();

        revalidateResolvers(resolvers());

        rightSidebarRefresh.schedule();

        searchRefresh.schedule();

        brokenBlockRefsRefresh.schedule();

        if (view().kind === "tag") {
          setTagRefreshTick((n) => n + 1);
        }

        doc.applyExternalChange(p.path, p.new_content_hash);
      }),
    );

    await vaultListeners.attach("vault:pending-rewrites-changed", () =>
      onVaultPendingRewritesChanged((p) => {
        if (p.vault_id !== vaultId()) return;
        setPendingRewritesCount(p.count);
        void doc.refreshFromDisk();
      }),
    );
    await vaultListeners.attach("vault:flush-complete", () =>
      onVaultFlushComplete((p) => {
        if (p.vault_id !== vaultId()) return;
        if (p.files_rewritten === 0 && p.refs_updated === 0) return;
        const refs = p.refs_updated;
        const files = p.files_rewritten;
        showToast(
          `Applied ${refs} reference update${refs === 1 ? "" : "s"} across ` +
            `${files} file${files === 1 ? "" : "s"}.`,
        );
      }),
    );
    await vaultListeners.attach("vault:setting-changed", () =>
      onVaultSettingChanged((p) => {
        if (p.vault_id !== vaultId()) return;
        void settings.hydrate(p.vault_id);
      }),
    );

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
      [GRAPH_COMMAND_ID]: graphTab.command,
    };
    attachGlobalKeys(() => settings.effectiveBindings(), globalCommands);

    const unwatchTheme = watchSystemTheme(() => {
      settings.reapplySystemTheme();
    });
    onCleanup(unwatchTheme);

    try {
      await refreshRecentVaults();
      const top = recentVaults()[0];
      if (top && top.exists) await openVaultByPath(top.path);
    } finally {
      setBooting(false);
    }
  });

  onCleanup(() => {
    vaultListeners.detach();
    doc.cancelScheduledWrite();
    rightSidebarRefresh.cancel();
    searchRefresh.cancel();
    brokenBlockRefsRefresh.cancel();
  });

  const releaseVault = () => {
    setFiles([]);
    setFolders([]);
    setFilesProcessed(0);
    setFilesTotalEstimate(0);
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
  };

  const openVaultByPath = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      const resp = await switchVault({
        open: () => openVault({ path }),
        release: releaseVault,
        adopt: (opened) => {
          setVaultPath(path);
          setVaultId(opened.vault_id);
          setScanStatus(opened.scan_status);
          setWikilinkResolver(createWikiLinkResolver(opened.vault_id));
          setEmbedResolver(createEmbedResolver(opened.vault_id));
          setPropertyResolver(createPropertyResolver(opened.vault_id));
          setAutocompleteProvider(createAutocompleteProvider(opened.vault_id));
          scheduleRefresh();
        },
      });
      await settings.hydrate(resp.vault_id);
      await refreshFileList();
      await restoreTabs(path);
      void refreshRecentVaults();
    } catch (e) {
      setError(errorMessage(e));
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
          <GraphButton
            available={graphTab.available}
            onOpen={graphTab.open}
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
              <FeatureBoundary feature="File explorer">
                <ExplorerPanel
                  files={files()}
                  folders={folders()}
                  vaultId={vaultId()}
                  selectedPath={selectedPath()}
                  mode={settings.leftSidebarMode()}
                  refreshSignal={searchRefreshTick()}
                  actions={fileActions}
                  onModeChange={settings.setLeftSidebarModeValue}
                  onRefresh={() => void refreshFileList()}
                  onNavigate={(path) => void handleNavigateWikilink(path, null)}
                  onSelectFile={(entry) => void handleSelectFile(entry)}
                  onRenameCommit={(from, target, isFolder) =>
                    void handleRenameCommit(from, target, isFolder)
                  }
                />
              </FeatureBoundary>
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
                <Show when={!isTerminalView(view()) && !isGraphView(view())}>
                  <Show
                    when={view().kind === "file"}
                    fallback={
                      <FeatureBoundary feature="Tag page">
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
                      </FeatureBoundary>
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
                                value={noteTitle(path)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    e.currentTarget.value = noteTitle(path);
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
                            <FeatureBoundary feature="Properties">
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
                            </FeatureBoundary>
                          </Show>
                          <FeatureBoundary feature="Editor">
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
                                    propertyRefsEnabled={pluginOn(
                                      "property-refs",
                                    )}
                                    mathEnabled={pluginOn("math")}
                                    equationsEnabled={pluginOn("equations")}
                                    dataviewRunner={dataviewRunner()}
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
                          </FeatureBoundary>
                        </Show>
                      }
                    >
                      {(path) => (
                        <FeatureBoundary feature="File viewer">
                          <FileViewer
                            vaultId={vaultId()!}
                            path={path}
                            sizeBytes={viewerEntry()?.size_bytes ?? 0}
                            mtimeUnix={viewerEntry()?.mtime_unix ?? 0}
                            rawSource={settings.effectiveRaw()}
                          />
                        </FeatureBoundary>
                      )}
                    </Show>
                  </Show>
                </Show>
                <FeatureBoundary feature="Graph">
                  <GraphTabPane vaultId={vaultId} tabs={tabs} theme={settings.resolvedTheme} onOpenFile={(p) => void handleNavigateWikilink(p, null)} />
                </FeatureBoundary>
                <FeatureBoundary feature="Terminal">
                  <TerminalTabPanes
                    tabs={tabs}
                    vaultId={vaultId}
                    resolvedTheme={settings.resolvedTheme}
                    onOpened={terminalTab.register}
                    onClosed={terminalTab.forget}
                  />
                </FeatureBoundary>
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
                <FeatureBoundary feature="Sidebar panel">
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
                </FeatureBoundary>
              </div>
            </div>
          </aside>
        </div>
      </Show>

      <FeatureBoundary feature="Omni-Bar">
        <OmniBar
          open={omniOpen()}
          items={omniItems()}
          recentNotes={recentNotes()}
          onClose={() => setOmniOpen(false)}
          onOpenNote={(path) => void handleNavigateWikilink(path, null)}
          onOpenTag={(tag) => void handleNavigateTag(tag)}
          onRunCommand={handleRunCommand}
        />
      </FeatureBoundary>

      <SettingsModal
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        vaultPath={vaultPath()}
        busy={busy()}
        onOpenAnotherVault={() => void handleOpen()}
      />

      <ConfirmDialog
        open={createOffer() !== null}
        title="Create note?"
        confirmLabel="Create note"
        tone="primary"
        onCancel={dismissCreateOffer}
        onConfirm={() => void acceptCreateOffer()}
      >
        <p>
          <code
            style={{
              "font-family": "var(--font-mono)",
              "font-size": "var(--text-xs)",
            }}
          >
            {createOffer()?.path}
          </code>{" "}
          does not exist yet.
        </p>
      </ConfirmDialog>

      <Show when={vaultId() && settings.statusbarEnabled()}>
        <FeatureBoundary feature="Status bar">
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
        </FeatureBoundary>
      </Show>

      <FileContextMenu actions={fileActions} />

      <DeleteDialog actions={fileActions} />

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
