import { createMemo, createSignal, For, Show, type Component } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { FileEntry } from "../api/ipc";
import { renameTarget } from "../fileRename";
import { computeWindow } from "../virtualList";
import FileRow from "./FileRow";
import FolderRow from "./FolderRow";
import { buildStableTreeRows, type FlatRow } from "./fileTree";
import type { FileActions } from "./fileActions";
import { FILE_LIST_OVERSCAN, FILE_ROW_HEIGHT } from "./rowMetrics";

export interface FileTreePanelProps {
  files: FileEntry[];
  folders: string[];
  vaultId: string | null;
  selectedPath: string | null;
  actions: FileActions;
  onSelectFile: (entry: FileEntry) => void;
  onRenameCommit: (fromPath: string, target: string, isFolder: boolean) => void;
}

const FileTreePanel: Component<FileTreePanelProps> = (props) => {
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
      props.files,
      props.folders,
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

  const commit = (fromPath: string, typed: string, isFolder: boolean) =>
    props.onRenameCommit(fromPath, renameTarget(fromPath, typed), isFolder);
  const cancelRename = () => props.actions.startRename(null);
  const isRenaming = (path: string) => props.actions.renamingPath() === path;

  return (
    <>
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
          props.actions.openContextMenu({
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
            <div style={{ transform: `translateY(${fileWindow().offsetY}px)` }}>
              <For each={visibleRows()}>
                {(row) =>
                  row.kind === "folder" ? (
                    <FolderRow
                      name={row.name}
                      depth={row.depth}
                      collapsed={row.collapsed}
                      renaming={isRenaming(row.path)}
                      onToggle={() => toggleFolder(row.path)}
                      onContextMenu={(x, y) =>
                        props.actions.openContextMenu({
                          kind: "folder",
                          path: row.path,
                          x,
                          y,
                        })
                      }
                      onRename={(typed) => commit(row.path, typed, true)}
                      onCancelRename={cancelRename}
                    />
                  ) : (
                    <FileRow
                      path={row.path}
                      name={row.name}
                      depth={row.depth}
                      typeId={row.typeId}
                      selected={props.selectedPath === row.path}
                      renaming={isRenaming(row.path)}
                      onOpen={() => {
                        const entry = props.files.find(
                          (f) => f.path === row.path,
                        );
                        if (entry) props.onSelectFile(entry);
                      }}
                      onContextMenu={(x, y) =>
                        props.actions.openContextMenu({
                          kind: "file",
                          path: row.path,
                          x,
                          y,
                        })
                      }
                      onRename={(typed) => commit(row.path, typed, false)}
                      onCancelRename={cancelRename}
                    />
                  )
                }
              </For>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
};

export default FileTreePanel;
