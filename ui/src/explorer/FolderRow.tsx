import { type Component } from "solid-js";

import FolderTreeRow from "@ds/components/data/FileTreeRow/FolderTreeRow";

import { FILE_ROW_HEIGHT } from "./rowMetrics";

export interface FolderRowProps {
  name: string;
  depth: number;
  collapsed: boolean;
  renaming: boolean;
  onToggle: () => void;
  onContextMenu: (x: number, y: number) => void;
  onRename: (typed: string) => void;
  onCancelRename: () => void;
}

const FolderRow: Component<FolderRowProps> = (props) => (
  <FolderTreeRow
    name={props.name}
    depth={props.depth}
    height={FILE_ROW_HEIGHT}
    collapsed={props.collapsed}
    renaming={props.renaming}
    onToggle={() => props.onToggle()}
    onContextMenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      props.onContextMenu(e.clientX, e.clientY);
    }}
    onRenameCommit={(typed) => props.onRename(typed)}
    onRenameCancel={() => props.onCancelRename()}
  />
);

export default FolderRow;
