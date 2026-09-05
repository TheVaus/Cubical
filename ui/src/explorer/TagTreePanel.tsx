import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";

import type { FileEntry, TagAssignmentDto } from "../api/ipc";
import { listTagAssignments, renameTag } from "../api/ipc";
import { errorMessage } from "../errorMessage";
import { renameTarget } from "../fileRename";
import { showErrorToast, showToast } from "../toastState";
import { computeWindow } from "../virtualList";
import FileRow from "./FileRow";
import FolderRow from "./FolderRow";
import type { FileActions } from "./fileActions";
import { FILE_LIST_OVERSCAN, FILE_ROW_HEIGHT } from "./rowMetrics";
import { buildStableTagRows, type TagFlatRow } from "./tagTree";

export interface TagTreePanelProps {
  files: FileEntry[];
  vaultId: string | null;
  selectedPath: string | null;
  reloadToken: number;
  actions: FileActions;
  onSelectFile: (entry: FileEntry) => void;
  onRenameCommit: (fromPath: string, target: string, isFolder: boolean) => void;
}

const TagTreePanel: Component<TagTreePanelProps> = (props) => {
  const [assignments, setAssignments] = createSignal<TagAssignmentDto[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(600);
  const [collapsedTags, setCollapsedTags] = createSignal<Set<string>>(
    new Set(),
  );
  const [selfReload, setSelfReload] = createSignal(0);
  const [renamingRowId, setRenamingRowId] = createSignal<string | null>(null);

  const toggleTag = (id: string) =>
    setCollapsedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let token = 0;
  createEffect(() => {
    const vid = props.vaultId;
    void props.reloadToken;
    void selfReload();

    if (!vid) {
      setAssignments([]);
      setLoaded(false);
      return;
    }
    const my = ++token;
    listTagAssignments({ vault_id: vid })
      .then((resp) => {
        if (my !== token) return;
        setAssignments(resp.assignments);
        setLoaded(true);
      })
      .catch((e) => {
        if (my !== token) return;
        showErrorToast(errorMessage(e));
        setLoaded(true);
      });
  });

  let prevRows: TagFlatRow[] = [];
  const rows = createMemo<TagFlatRow[]>(() => {
    prevRows = buildStableTagRows(
      prevRows,
      assignments(),
      props.files,
      collapsedTags(),
    );
    return prevRows;
  });

  const listWindow = createMemo(() =>
    computeWindow(
      scrollTop(),
      viewportHeight(),
      FILE_ROW_HEIGHT,
      rows().length,
      FILE_LIST_OVERSCAN,
    ),
  );
  const visibleRows = createMemo(() =>
    rows().slice(listWindow().startIndex, listWindow().endIndex),
  );

  const cancelRename = () => props.actions.startTagRename(null);

  const commitTagRename = async (tagPath: string, typed: string) => {
    props.actions.startTagRename(null);
    const vid = props.vaultId;
    const next = renameTarget(tagPath, typed);
    if (!vid || next === tagPath || next.trim() === "") return;
    try {
      const resp = await renameTag({
        vault_id: vid,
        old_tag: tagPath,
        new_tag: next,
      });
      showToast(
        resp.pending_count > 0
          ? `Renamed #${tagPath} to #${next} — ${resp.pending_count} rewrite(s) pending.`
          : `Renamed #${tagPath} to #${next}.`,
      );
      setSelfReload((n) => n + 1);
    } catch (e) {
      showErrorToast(errorMessage(e));
    }
  };

  return (
    <div
      role="listbox"
      aria-label="Vault tags"
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
        when={rows().length > 0}
        fallback={
          <div
            style={{
              padding: "var(--space-3)",
              "font-size": "var(--text-sm)",
              color: "var(--c-fg-muted)",
            }}
          >
            {loaded() ? "No tags yet…" : "Loading…"}
          </div>
        }
      >
        <div
          style={{
            height: `${listWindow().totalHeight}px`,
            position: "relative",
          }}
        >
          <div style={{ transform: `translateY(${listWindow().offsetY}px)` }}>
            <For each={visibleRows()}>
              {(row) =>
                row.kind === "tag" ? (
                  <FolderRow
                    name={row.name}
                    depth={row.depth}
                    collapsed={row.collapsed}
                    renaming={props.actions.renamingTag() === row.id}
                    onToggle={() => toggleTag(row.id)}
                    onContextMenu={(x, y) => {
                      if (!row.renamable) return;
                      props.actions.openContextMenu({
                        kind: "tag",
                        path: row.id,
                        x,
                        y,
                      });
                    }}
                    onRename={(typed) => void commitTagRename(row.id, typed)}
                    onCancelRename={cancelRename}
                  />
                ) : (
                  <FileRow
                    path={row.path}
                    name={row.name}
                    depth={row.depth}
                    typeId={row.typeId}
                    selected={props.selectedPath === row.path}
                    renaming={
                      props.actions.renamingPath() === row.path &&
                      renamingRowId() === row.id
                    }
                    onOpen={() => {
                      const entry = props.files.find(
                        (f) => f.path === row.path,
                      );
                      if (entry) props.onSelectFile(entry);
                    }}
                    onContextMenu={(x, y) => {
                      setRenamingRowId(row.id);
                      props.actions.openContextMenu({
                        kind: "file",
                        path: row.path,
                        x,
                        y,
                      });
                    }}
                    onRename={(typed) =>
                      props.onRenameCommit(
                        row.path,
                        renameTarget(row.path, typed),
                        false,
                      )
                    }
                    onCancelRename={() => props.actions.startRename(null)}
                  />
                )
              }
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default TagTreePanel;
