import {
  createEffect,
  on,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

import { normalize } from "./ast/normalize";
import type { CanonicalDocument } from "./ast/types";
import { livePreviewDecorations } from "./editor/decorations";

/**
 * Holds the Live Preview decoration extension. L2 Session E (raw-source
 * toggle) reconfigures this compartment to a no-op extension (`[]`) to
 * reveal the raw markdown; Lezer parsing keeps running either way. This
 * is the seam — Session B only installs the compartment, it does not
 * build the toggle.
 */
const decorationCompartment = new Compartment();

/**
 * CodeMirror 6 markdown editor surface.
 *
 * Owns its own DOM and `EditorView` — Solid stays out of it so the
 * webview's main-thread Lane 1 contract holds. The component exposes:
 *
 * - `onAstChange` — the freshly-normalized canonical AST, debounced
 *   150ms (downstream consumers like the L1 footer / the future L2
 *   Properties UI).
 * - `onContentChange` — raw doc text on every `docChanged` update. The
 *   autosave timer (300ms) lives in the parent so blur / file-change
 *   flushes can coordinate with the buffer the user is *about to*
 *   leave. The Editor is too local to know when those things happen.
 * - `onBlur` — fires when the CM6 view loses focus, so the parent can
 *   force-flush a pending autosave (L2 spec §2.1).
 *
 * `ref(api)` exposes imperative handles the parent needs:
 * - `getContent()` — current doc text, useful when flushing on
 *   file-change before reading the new file.
 * - `replaceContent(next)` — drop in new bytes (used by the conflict
 *   banner's "Reload from disk" action).
 */
export interface EditorApi {
  getContent: () => string;
  replaceContent: (next: string) => void;
}

export interface EditorProps {
  /** Initial document content; replacing it via prop swaps the doc. */
  value: string;
  onAstChange?: (doc: CanonicalDocument) => void;
  onContentChange?: (content: string) => void;
  onBlur?: () => void;
  /** Imperative handle, set on mount. */
  ref?: (api: EditorApi) => void;
}

const AST_DEBOUNCE_MS = 150;

const Editor: Component<EditorProps> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let astPending: ReturnType<typeof setTimeout> | undefined;

  const fireAst = (source: string) => {
    if (!props.onAstChange) return;
    props.onAstChange(normalize(source));
  };

  const scheduleAst = (source: string) => {
    if (!props.onAstChange) return;
    if (astPending !== undefined) clearTimeout(astPending);
    astPending = setTimeout(() => {
      astPending = undefined;
      fireAst(source);
    }, AST_DEBOUNCE_MS);
  };

  onMount(() => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const source = update.state.doc.toString();
      scheduleAst(source);
      props.onContentChange?.(source);
    });

    const focusListener = EditorView.focusChangeEffect.of((_state, focusing) => {
      if (!focusing) props.onBlur?.();
      return null;
    });

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          decorationCompartment.of(livePreviewDecorations),
          updateListener,
          focusListener,
          EditorView.theme({
            // Placeholder; L2 wires the real CSS-variable token surface.
            "&": {
              height: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--c-fg-primary)",
              background: "var(--c-bg-primary)",
            },
            ".cm-scroller": { overflow: "auto" },
            ".cm-content": { padding: "var(--space-3)" },
          }),
        ],
      }),
    });

    // Fire the initial AST synchronously so consumers don't have to
    // wait for the first keystroke to know what's loaded.
    fireAst(props.value);

    props.ref?.({
      getContent: () => view?.state.doc.toString() ?? "",
      replaceContent: (next) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === next) return;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: next },
        });
      },
    });
  });

  // Replace the document when `value` changes externally. Compare
  // against the current content so we don't fight a buffer the user
  // is actively editing.
  createEffect(
    on(
      () => props.value,
      (next) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === next) return;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: next },
        });
        // The updateListener above will schedule the AST + onContentChange.
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    if (astPending !== undefined) clearTimeout(astPending);
    view?.destroy();
    view = undefined;
  });

  return (
    <div
      ref={host}
      style={{
        flex: "1",
        "min-height": "0",
        display: "flex",
        "flex-direction": "column",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-primary)",
        overflow: "hidden",
      }}
    />
  );
};

export default Editor;
