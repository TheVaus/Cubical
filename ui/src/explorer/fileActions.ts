import { createSignal } from "solid-js";

import { createFile, createFolder, deleteFile } from "../api/ipc";
import { errorMessage } from "../errorMessage";
import { showErrorToast } from "../toastState";

export type EntryKind = "file" | "folder";

export interface ContextMenuTarget {
  kind: EntryKind | "empty" | "tag";
  path: string;
  x: number;
  y: number;
}

export interface DeleteTarget {
  path: string;
  kind: EntryKind;
  fileCount: number;
}

export interface FileActionsDeps {
  vaultId: () => string | null;
  refreshFileList: () => Promise<void>;
  openCreatedFile: (path: string, contentHash: string) => Promise<void>;
  reportError: (message: string) => void;
  countFilesUnderFolder: (path: string) => number;
}

export interface FileActions {
  readonly contextMenu: () => ContextMenuTarget | null;
  readonly openContextMenu: (target: ContextMenuTarget) => void;
  readonly closeContextMenu: () => void;
  readonly deleteTarget: () => DeleteTarget | null;
  readonly deleteInFlight: () => boolean;
  readonly renamingPath: () => string | null;
  readonly startRename: (path: string | null) => void;
  readonly renamingTag: () => string | null;
  readonly startTagRename: (tagPath: string | null) => void;
  readonly newFile: (parentDir: string) => Promise<void>;
  readonly newFolder: (parentDir: string) => Promise<void>;
  readonly newFileInTree: (parentDir: string) => Promise<void>;
  readonly newFolderInTree: (parentDir: string) => Promise<void>;
  readonly requestDelete: (path: string, kind: EntryKind) => void;
  readonly cancelDelete: () => void;
  readonly confirmDelete: () => Promise<void>;
  readonly reset: () => void;
}

export function createFileActions(deps: FileActionsDeps): FileActions {
  const [contextMenu, setContextMenu] = createSignal<ContextMenuTarget | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = createSignal<DeleteTarget | null>(
    null,
  );
  const [deleteInFlight, setDeleteInFlight] = createSignal(false);
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  const [renamingTag, setRenamingTag] = createSignal<string | null>(null);

  const newFile = async (parentDir: string) => {
    const id = deps.vaultId();
    if (!id) return;
    try {
      const resp = await createFile({ vault_id: id, parent_dir: parentDir });
      await deps.refreshFileList();
      await deps.openCreatedFile(resp.path, resp.content_hash);
    } catch (e) {
      deps.reportError(errorMessage(e));
    }
  };

  const newFolder = async (parentDir: string) => {
    const id = deps.vaultId();
    if (!id) return;
    try {
      await createFolder({ vault_id: id, parent_dir: parentDir });
      await deps.refreshFileList();
    } catch (e) {
      deps.reportError(errorMessage(e));
    }
  };

  const newFileInTree = async (parentDir: string) => {
    const id = deps.vaultId();
    if (!id) return;
    try {
      const resp = await createFile({ vault_id: id, parent_dir: parentDir });
      await deps.refreshFileList();
      setRenamingPath(resp.path);
    } catch (e) {
      showErrorToast(errorMessage(e));
    }
  };

  const newFolderInTree = async (parentDir: string) => {
    const id = deps.vaultId();
    if (!id) return;
    try {
      await createFolder({ vault_id: id, parent_dir: parentDir });
      await deps.refreshFileList();
    } catch (e) {
      showErrorToast(errorMessage(e));
    }
  };

  const confirmDelete = async () => {
    const id = deps.vaultId();
    const target = deleteTarget();
    if (!id || !target) return;
    setDeleteInFlight(true);
    try {
      await deleteFile({ vault_id: id, path: target.path });
      setDeleteTarget(null);
    } catch (e) {
      showErrorToast(errorMessage(e));
    } finally {
      setDeleteInFlight(false);
    }
  };

  return {
    contextMenu,
    openContextMenu: (target: ContextMenuTarget) => setContextMenu(target),
    closeContextMenu: () => setContextMenu(null),
    deleteTarget,
    deleteInFlight,
    renamingPath,
    startRename: (path: string | null) => setRenamingPath(path),
    renamingTag,
    startTagRename: (tagPath: string | null) => setRenamingTag(tagPath),
    newFile,
    newFolder,
    newFileInTree,
    newFolderInTree,
    requestDelete: (path: string, kind: EntryKind) =>
      setDeleteTarget({
        path,
        kind,
        fileCount: kind === "folder" ? deps.countFilesUnderFolder(path) : 0,
      }),
    cancelDelete: () => setDeleteTarget(null),
    confirmDelete,
    reset: () => {
      setContextMenu(null);
      setDeleteTarget(null);
      setRenamingPath(null);
      setRenamingTag(null);
      setDeleteInFlight(false);
    },
  };
}
