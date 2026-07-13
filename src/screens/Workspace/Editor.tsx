import { onCleanup, onMount } from 'solid-js';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import './Editor.css';

export interface EditorProps {
  initialContent: string;
  onReady?: (view: EditorView) => void;
}

const cubicalTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--text-base)',
    color: 'var(--c-fg-primary)',
    backgroundColor: 'var(--c-bg-primary)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-sans)',
    padding: 'var(--space-6)',
    caretColor: 'var(--c-accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--c-bg-primary)',
    color: 'var(--c-fg-muted)',
    border: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--c-bg-secondary)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--c-bg-secondary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--c-bg-tertiary)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--c-accent)' },
});

const Editor = (props: EditorProps) => {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: props.initialContent,
        extensions: [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), markdown(), cubicalTheme],
      }),
      parent: host,
    });
    props.onReady?.(view);
  });

  onCleanup(() => view?.destroy());

  return <div class="editor scroll-y" ref={host} />;
};

export default Editor;
