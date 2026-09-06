import { Show, type Component } from "solid-js";

import FileTreeRow from "@ds/components/data/FileTreeRow/FileTreeRow";
import Icon from "@ds/components/graphics/Icon/Icon";

import { isValidNoteName, noteNameError } from "../vault/noteName";
import { hasViewer } from "../viewer";
import { splitFileName } from "./fileTree";
import { FILE_ROW_HEIGHT } from "./rowMetrics";

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

  const nameTitle = () => {
    if (isDotted()) return noteNameError(props.name);
    if (isUnsupported()) {
      return `Cubical has no viewer for .${parts().ext} files — the file is untouched on disk.`;
    }
    return undefined;
  };

  return (
    <FileTreeRow
      name={props.renaming ? props.name : parts().stem}
      ext={props.renaming ? undefined : parts().ext || undefined}
      depth={props.depth}
      height={FILE_ROW_HEIGHT}
      selected={props.selected}
      invalid={isDotted()}
      unsupported={isUnsupported()}
      nameTitle={nameTitle()}
      renaming={props.renaming}
      onClick={() => props.onOpen()}
      onContextMenu={(e) => {
        if (!isMarkdown()) return;
        e.preventDefault();
        e.stopPropagation();
        props.onContextMenu(e.clientX, e.clientY);
      }}
      onRenameCommit={(typed) => props.onRename(typed)}
      onRenameCancel={() => props.onCancelRename()}
      badge={
        <>
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
        </>
      }
    />
  );
};

export default FileRow;
