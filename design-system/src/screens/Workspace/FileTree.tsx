import { For, createSignal, Show } from 'solid-js';
import FileTreeRow from '../../components/data/FileTreeRow/FileTreeRow';
import { VaultNode } from '../../fixtures/vault';
import './FileTree.css';

export interface FileTreeProps {
  nodes: VaultNode[];
  selectedId: string;
  onSelect: (node: VaultNode) => void;
}

const FileTreeBranch = (props: {
  node: VaultNode;
  depth: number;
  selectedId: string;
  onSelect: (node: VaultNode) => void;
}) => {
  const [expanded, setExpanded] = createSignal(true);
  const isFolder = () => props.node.kind === 'folder';

  return (
    <div>
      <FileTreeRow
        name={props.node.name}
        depth={props.depth}
        kind={isFolder() ? (expanded() ? 'folder-open' : 'folder') : props.node.kind}
        selected={props.selectedId === props.node.id}
        invalid={props.node.kind === 'broken'}
        onClick={() => (isFolder() ? setExpanded((v) => !v) : props.onSelect(props.node))}
      />
      <Show when={isFolder() && expanded()}>
        <For each={props.node.children}>
          {(child) => (
            <FileTreeBranch node={child} depth={props.depth + 1} selectedId={props.selectedId} onSelect={props.onSelect} />
          )}
        </For>
      </Show>
    </div>
  );
};

const FileTree = (props: FileTreeProps) => {
  return (
    <div class="file-tree scroll-y">
      <For each={props.nodes}>
        {(node) => <FileTreeBranch node={node} depth={0} selectedId={props.selectedId} onSelect={props.onSelect} />}
      </For>
    </div>
  );
};

export default FileTree;
