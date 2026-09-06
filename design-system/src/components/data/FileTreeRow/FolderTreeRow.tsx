import { Show } from 'solid-js';
import Icon from '../../graphics/Icon/Icon';
import RenameInput from './RenameInput';
import { TREE_ROW_HEIGHT, folderPadding } from './rowGeometry';
import './FileTreeRow.css';

export interface FolderTreeRowProps {
  name: string;
  depth: number;
  collapsed: boolean;
  height?: number;
  renaming?: boolean;
  onToggle?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  onRenameCommit?: (name: string) => void;
  onRenameCancel?: () => void;
}

const FolderTreeRow = (props: FolderTreeRowProps) => (
  <div
    class="tree-row tree-row--folder"
    role="treeitem"
    aria-expanded={!props.collapsed}
    style={{
      height: `${props.height ?? TREE_ROW_HEIGHT}px`,
      'padding-left': folderPadding(props.depth),
    }}
    onClick={() => {
      if (props.renaming) return;
      props.onToggle?.();
    }}
    onContextMenu={(e) => props.onContextMenu?.(e)}
  >
    <span class="tree-row__twisty">
      <Icon name={props.collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
    </span>
    <Show
      when={props.renaming}
      fallback={<span class="tree-row__name">{props.name}</span>}
    >
      <RenameInput
        value={props.name}
        onCommit={(n) => props.onRenameCommit?.(n)}
        onCancel={() => props.onRenameCancel?.()}
      />
    </Show>
  </div>
);

export default FolderTreeRow;
