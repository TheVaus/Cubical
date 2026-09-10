import {
  createEffect,
  createSignal,
  on,
  Show,
  type Component,
  type JSXElement,
} from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { FileEntry } from "../api/ipc";
import type { LeftSidebarMode } from "../settings/settingsState";
import FeatureBoundary from "../core/FeatureBoundary";
import { CanViewContext, cannotView, type CanView } from "./canView";
import FileTreePanel from "./FileTreePanel";
import TagTreePanel from "./TagTreePanel";
import type { FileActions } from "./fileActions";

export interface ExplorerSearchSlot {
  active: () => boolean;
  bar: () => JSXElement;
  results: () => JSXElement;
}

export interface ExplorerPanelProps {
  files: FileEntry[];
  folders: string[];
  vaultId: string | null;
  selectedPath: string | null;
  mode: LeftSidebarMode;
  refreshSignal: number;
  actions: FileActions;
  onModeChange: (mode: string) => void;
  onRefresh: () => void;
  onSelectFile: (entry: FileEntry) => void;
  onRenameCommit: (fromPath: string, target: string, isFolder: boolean) => void;
  search?: ExplorerSearchSlot;
  canView?: CanView;
}

const MODES = [
  { value: "files", label: "Files", icon: "file-text" as const },
  { value: "tags", label: "Tags", icon: "hash" as const },
];

const ExplorerPanel: Component<ExplorerPanelProps> = (props) => {
  const [reloadToken, setReloadToken] = createSignal(0);
  const [syncedSignal, setSyncedSignal] = createSignal(0);

  const reloadTags = () => {
    setSyncedSignal(props.refreshSignal);
    setReloadToken((n) => n + 1);
  };

  createEffect(
    on(
      () => props.mode,
      (mode) => {
        if (mode === "tags") reloadTags();
      },
    ),
  );

  const tagsStale = () => props.refreshSignal !== syncedSignal();
  const refreshDisabled = () => props.mode === "tags" && !tagsStale();

  const refreshLabel = () =>
    props.mode === "tags"
      ? tagsStale()
        ? "Refresh tags"
        : "Tags are up to date"
      : "Refresh file list";

  const handleRefresh = () => {
    props.onRefresh();
    if (props.mode === "tags") reloadTags();
  };

  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        "min-width": 0,
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-2)",
      }}
    >
      <Show when={props.search}>
        {(search) => (
          <FeatureBoundary feature="Search">{search().bar()}</FeatureBoundary>
        )}
      </Show>

      <div
        style={{
          position: "relative",
          flex: 1,
          "min-height": 0,
          "min-width": 0,
          display: "flex",
          "flex-direction": "column",
        }}
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
          <SegmentedControl
            options={MODES}
            value={props.mode}
            variant="tabs"
            role="tablist"
            onChange={props.onModeChange}
          />
          <span style={{ display: "flex", gap: "var(--space-1)" }}>
            <Show when={props.mode === "files"}>
              <IconButton
                label="New file"
                size="sm"
                disabled={!props.vaultId}
                onClick={() => void props.actions.newFile("")}
                style={{ "font-size": "var(--text-sm)" }}
              >
                <Icon name="plus" />
              </IconButton>
              <IconButton
                label="New folder"
                size="sm"
                disabled={!props.vaultId}
                onClick={() => void props.actions.newFolder("")}
                style={{ "font-size": "var(--text-sm)" }}
              >
                <Icon name="folder-plus" />
              </IconButton>
            </Show>
            <IconButton
              label={refreshLabel()}
              size="sm"
              disabled={!props.vaultId || refreshDisabled()}
              onClick={handleRefresh}
              style={{ "font-size": "var(--text-sm)" }}
            >
              <Icon name="refresh-cw" />
            </IconButton>
          </span>
        </div>

        <FeatureBoundary feature="File tree">
          <CanViewContext.Provider value={props.canView ?? cannotView}>
            <Show
              when={props.mode === "tags"}
              fallback={
                <FileTreePanel
                  files={props.files}
                  folders={props.folders}
                  vaultId={props.vaultId}
                  selectedPath={props.selectedPath}
                  actions={props.actions}
                  onSelectFile={props.onSelectFile}
                  onRenameCommit={props.onRenameCommit}
                />
              }
            >
              <TagTreePanel
                files={props.files}
                vaultId={props.vaultId}
                selectedPath={props.selectedPath}
                reloadToken={reloadToken()}
                actions={props.actions}
                onSelectFile={props.onSelectFile}
                onRenameCommit={props.onRenameCommit}
              />
            </Show>
          </CanViewContext.Provider>
        </FeatureBoundary>

        <Show when={props.search?.active()}>
          <FeatureBoundary feature="Search results">
            {props.search?.results()}
          </FeatureBoundary>
        </Show>
      </div>
    </div>
  );
};

export default ExplorerPanel;
