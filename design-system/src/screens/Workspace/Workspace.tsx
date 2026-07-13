import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { EditorView } from '@codemirror/view';
import Topbar from './Topbar';
import FileTree from './FileTree';
import Editor from './Editor';
import Minimap from './Minimap';
import RightSidebar from './RightSidebar';
import StatusBar from './StatusBar';
import CommandPalette, { Command } from '../../components/overlay/CommandPalette/CommandPalette';
import { vaultTree, VaultNode } from '../../fixtures/vault';
import { activeNote } from '../../fixtures/notes';
import { setScreen } from '../../App';
import './Workspace.css';

const Workspace = () => {
  const [selectedId, setSelectedId] = createSignal(activeNote.id);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [editorView, setEditorView] = createSignal<EditorView>();

  const wordCount = createMemo(() => activeNote.body.trim().split(/\s+/).filter(Boolean).length);

  const jumpToLine = (lineIndex: number) => {
    const view = editorView();
    if (!view) return;
    const line = view.state.doc.line(Math.min(lineIndex + 1, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen(true);
    }
  };

  onMount(() => document.addEventListener('keydown', handleKeydown));
  onCleanup(() => document.removeEventListener('keydown', handleKeydown));

  const selectNode = (node: VaultNode) => setSelectedId(node.id);

  const commands: Command[] = [
    { id: 'open-settings', label: 'Open settings', onRun: () => setScreen('settings') },
    { id: 'open-daily', label: "Open today's daily note", onRun: () => setSelectedId('2026-07-13') },
  ];

  return (
    <div class="workspace stack">
      <Topbar
        vaultName="Cubical vault"
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setScreen('settings')}
      />
      <div class="workspace-body row">
        <FileTree nodes={vaultTree} selectedId={selectedId()} onSelect={selectNode} />
        <Editor initialContent={activeNote.body} onReady={setEditorView} />
        <Minimap content={activeNote.body} onJump={jumpToLine} />
        <RightSidebar />
      </div>
      <StatusBar wordCount={wordCount()} noteTitle={activeNote.title} />
      <CommandPalette open={paletteOpen()} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
};

export default Workspace;
