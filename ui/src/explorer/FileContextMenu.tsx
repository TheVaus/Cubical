import { Show, type Component } from "solid-js";

import Menu from "@ds/components/overlay/Menu/Menu";

import { buildContextMenuItems } from "./contextMenuItems";
import type { FileActions } from "./fileActions";

export interface FileContextMenuProps {
  actions: FileActions;
}

const FileContextMenu: Component<FileContextMenuProps> = (props) => {
  const dismiss = () => props.actions.closeContextMenu();

  return (
    <Show when={props.actions.contextMenu()}>
      {(menu) => (
        <>
          <div
            onClick={dismiss}
            onContextMenu={(e) => {
              e.preventDefault();
              dismiss();
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
            <Menu
              items={buildContextMenuItems(menu(), {
                newFile: (dir) => {
                  dismiss();
                  void props.actions.newFileInTree(dir);
                },
                newFolder: (dir) => {
                  dismiss();
                  void props.actions.newFolderInTree(dir);
                },
                rename: (path) => {
                  dismiss();
                  props.actions.startRename(path);
                },
                remove: (path, kind) => {
                  dismiss();
                  props.actions.requestDelete(path, kind);
                },
              })}
            />
          </div>
        </>
      )}
    </Show>
  );
};

export default FileContextMenu;
