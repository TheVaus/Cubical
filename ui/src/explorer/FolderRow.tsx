import { Show, type Component } from "solid-js";

import Icon from "@ds/components/graphics/Icon/Icon";

import { FILE_ROW_HEIGHT, folderPadding } from "./rowMetrics";

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
  <div
    class="tree-row tree-row--folder"
    role="treeitem"
    aria-expanded={!props.collapsed}
    style={{
      height: `${FILE_ROW_HEIGHT}px`,
      "padding-left": folderPadding(props.depth),
    }}
    onClick={() => {
      if (props.renaming) return;
      props.onToggle();
    }}
    onContextMenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      props.onContextMenu(e.clientX, e.clientY);
    }}
  >
    <span class="tree-row__twisty">
      <Icon
        name={props.collapsed ? "chevron-right" : "chevron-down"}
        size={14}
      />
    </span>
    <Show
      when={props.renaming}
      fallback={<span class="tree-row__name">{props.name}</span>}
    >
      <input
        type="text"
        class="tree-row__input"
        value={props.name}
        autofocus
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onRename(e.currentTarget.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            props.onCancelRename();
          }
        }}
        onBlur={(e) => props.onRename(e.currentTarget.value)}
      />
    </Show>
  </div>
);

export default FolderRow;
