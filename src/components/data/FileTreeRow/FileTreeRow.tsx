import { Show, createSignal } from 'solid-js';
import FileIcon, { FileKind } from './FileIcon';
import './FileTreeRow.css';

export interface FileTreeRowProps {
  name: string;
  depth: number;
  kind: FileKind;
  selected?: boolean;
  invalid?: boolean;
  renaming?: boolean;
  onClick?: () => void;
  onRenameCommit?: (name: string) => void;
}

const FileTreeRow = (props: FileTreeRowProps) => {
  const [draft, setDraft] = createSignal(props.name);

  return (
    <div
      class="file-tree-row row"
      classList={{ selected: props.selected, invalid: props.invalid }}
      style={{ 'padding-left': `calc(var(--space-3) + ${props.depth} * var(--space-5))` }}
      role="treeitem"
      tabindex={props.renaming ? undefined : 0}
      onClick={() => props.onClick?.()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.key === ' ') e.preventDefault();
          props.onClick?.();
        }
      }}
    >
      <FileIcon kind={props.kind} />
      <Show
        when={!props.renaming}
        fallback={
          <input
            class="file-tree-rename-input"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && props.onRenameCommit?.(draft())}
            onBlur={() => props.onRenameCommit?.(draft())}
            autofocus
          />
        }
      >
        <span class="file-tree-name">{props.name}</span>
      </Show>
      <Show when={props.invalid}>
        <span class="file-tree-warning" aria-label="Invalid">⚠</span>
      </Show>
    </div>
  );
};

export default FileTreeRow;
