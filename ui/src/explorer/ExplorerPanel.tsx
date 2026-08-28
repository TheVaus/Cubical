import { createEffect, createSignal, on, Show, type Component } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { FileEntry } from "../api/ipc";
import type { LeftSidebarMode } from "../settings/settingsState";
import SearchPanel from "../sidebar/SearchPanel";
import FileTreePanel from "./FileTreePanel";
import TagTreePanel from "./TagTreePanel";
import type { FileActions } from "./fileActions";

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
  onNavigate: (path: string) => void;
  onSelectFile: (entry: FileEntry) => void;
  onRenameCommit: (fromPath: string, target: string, isFolder: boolean) => void;
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
    <SearchPanel
      vaultId={props.vaultId}
      onNavigate={props.onNavigate}
      refreshSignal={props.refreshSignal}
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
    </SearchPanel>
  );
};

export default ExplorerPanel;
