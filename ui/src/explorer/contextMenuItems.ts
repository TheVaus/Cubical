import type { MenuItem } from "@ds/components/overlay/Menu/Menu";

import type { ContextMenuTarget, EntryKind } from "./fileActions";

export interface ContextMenuHandlers {
  newFile: (parentDir: string) => void;
  newFolder: (parentDir: string) => void;
  rename: (path: string) => void;
  remove: (path: string, kind: EntryKind) => void;
  renameTag: (tagPath: string) => void;
}

export function buildContextMenuItems(
  target: Pick<ContextMenuTarget, "kind" | "path">,
  on: ContextMenuHandlers,
): MenuItem[] {
  const items: MenuItem[] = [];
  if (target.kind === "tag") {
    return [
      {
        id: "rename-tag",
        label: "Rename Tag…",
        onSelect: () => on.renameTag(target.path),
      },
    ];
  }
  if (target.kind !== "file") {
    items.push({
      id: "new-file",
      label: "New File",
      onSelect: () => on.newFile(target.path),
    });
    items.push({
      id: "new-folder",
      label: "New Folder",
      onSelect: () => on.newFolder(target.path),
    });
  }
  if (target.kind !== "empty") {
    items.push({
      id: "rename",
      label: "Rename…",
      onSelect: () => on.rename(target.path),
    });
    items.push({
      id: "delete",
      label: "Delete…",
      danger: true,
      onSelect: () =>
        on.remove(target.path, target.kind === "folder" ? "folder" : "file"),
    });
  }
  return items;
}
