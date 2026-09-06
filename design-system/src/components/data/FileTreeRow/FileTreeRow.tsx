import { Show, type JSX } from 'solid-js';
import FileIcon, { type FileKind } from './FileIcon';
import RenameInput from './RenameInput';
import { TREE_ROW_HEIGHT, filePadding } from './rowGeometry';
import './FileTreeRow.css';

export interface FileTreeRowProps {
  name: string;
  depth: number;
  ext?: string | undefined;
  kind?: FileKind;
  height?: number;
  selected?: boolean;
  invalid?: boolean;
  unsupported?: boolean;
  nameTitle?: string | undefined;
  badge?: JSX.Element;
  renaming?: boolean;
  focusable?: boolean;
  role?: 'option' | 'treeitem';
  onClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  onRenameCommit?: (name: string) => void;
  onRenameCancel?: () => void;
}

const FileTreeRow = (props: FileTreeRowProps) => (
  <div
    class="tree-row tree-row--file"
    classList={{
      'tree-row--selected': props.selected,
      'tree-row--unsupported': props.unsupported,
    }}
    role={props.role ?? 'option'}
    aria-selected={(props.role ?? 'option') === 'option' ? props.selected : undefined}
    style={{
      height: `${props.height ?? TREE_ROW_HEIGHT}px`,
      'padding-left': filePadding(props.depth),
    }}
    tabindex={props.focusable && !props.renaming ? 0 : undefined}
    onClick={() => {
      if (props.renaming) return;
      props.onClick?.();
    }}
    onKeyDown={(e) => {
      if (!props.focusable || props.renaming) return;
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.key === ' ') e.preventDefault();
        props.onClick?.();
      }
    }}
    onContextMenu={(e) => props.onContextMenu?.(e)}
  >
    <Show when={props.kind}>
      {(kind) => (
        <span class="tree-row__icon">
          <FileIcon kind={kind()} />
        </span>
      )}
    </Show>
    <Show
      when={props.renaming}
      fallback={
        <span
          class="tree-row__name"
          classList={{
            'tree-row__name--dotted': props.invalid,
            'tree-row__name--unsupported': props.unsupported,
          }}
          title={props.nameTitle}
        >
          {props.name}
          <Show when={props.ext}>
            <span class="tree-row__ext">.{props.ext}</span>
          </Show>
          {props.badge}
        </span>
      }
    >
      <RenameInput
        value={props.name}
        onCommit={(n) => props.onRenameCommit?.(n)}
        onCancel={() => props.onRenameCancel?.()}
      />
    </Show>
  </div>
);

export default FileTreeRow;
