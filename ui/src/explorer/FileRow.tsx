import { Show, type Component } from "solid-js";

import Icon from "@ds/components/graphics/Icon/Icon";

import { isValidNoteName, noteNameError } from "../vault/noteName";
import { hasViewer } from "../viewer";
import { splitFileName } from "./fileTree";
import { FILE_ROW_HEIGHT, filePadding } from "./rowMetrics";

export interface FileRowProps {
  path: string;
  name: string;
  depth: number;
  typeId: string;
  selected: boolean;
  renaming: boolean;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
  onRename: (typed: string) => void;
  onCancelRename: () => void;
}

const FileRow: Component<FileRowProps> = (props) => {
  const isMarkdown = () => props.typeId === "markdown";
  const isUnsupported = () => !isMarkdown() && !hasViewer(props.path);
  const isDotted = () => isMarkdown() && !isValidNoteName(props.name);
  const parts = () => splitFileName(props.name);

  return (
    <div
      class="tree-row tree-row--file"
      classList={{
        "tree-row--selected": props.selected,
        "tree-row--unsupported": isUnsupported(),
      }}
      role="option"
      aria-selected={props.selected}
      style={{
        height: `${FILE_ROW_HEIGHT}px`,
        "padding-left": filePadding(props.depth),
      }}
      onClick={() => {
        if (props.renaming) return;
        props.onOpen();
      }}
      onContextMenu={(e) => {
        if (!isMarkdown()) return;
        e.preventDefault();
        e.stopPropagation();
        props.onContextMenu(e.clientX, e.clientY);
      }}
    >
      <Show
        when={props.renaming}
        fallback={
          <span
            class="tree-row__name"
            classList={{
              "tree-row__name--dotted": isDotted(),
              "tree-row__name--unsupported": isUnsupported(),
            }}
            title={
              isDotted()
                ? noteNameError(props.name)
                : isUnsupported()
                  ? `Cubical has no viewer for .${parts().ext} files — the file is untouched on disk.`
                  : undefined
            }
          >
            {parts().stem}
            <Show when={parts().ext !== ""}>
              <span class="tree-row__ext">.{parts().ext}</span>
            </Show>
            <Show when={isDotted()}>
              <span class="tree-row__dotted-badge" aria-hidden="true">
                {" "}
                <Icon name="warning" />
              </span>
            </Show>
            <Show when={isUnsupported()}>
              <span
                class="tree-row__unsupported-badge"
                aria-label="Unsupported file"
                role="img"
              >
                {" "}
                <Icon name="info" />
              </span>
            </Show>
          </span>
        }
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
};

export default FileRow;
