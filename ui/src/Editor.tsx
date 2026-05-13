import {
  createEffect,
  on,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

import { normalize } from "./ast/normalize";
import type { CanonicalDocument } from "./ast/types";

/**
 * CodeMirror 6 markdown editor surface.
 *
 * Owns its own DOM and `EditorView` — Solid stays out of it so the
 * webview's main-thread Lane 1 contract holds. The component exposes
 * a one-way `onAstChange` callback that fires the Lezer-backed
 * canonical AST whenever the document changes (debounced 150ms).
 *
 * L1 ships raw markdown only. Live Preview decorations + a real
 * theme arrive in L2; this component is intentionally minimal so the
 * pipeline (CM6 → Lezer → canonical AST → IPC consumers) is the
 * thing under test, not visual polish.
 */
export interface EditorProps {
  /** Initial document content; replacing it via prop swaps the doc. */
  value: string;
  /**
   * Fires on every doc change with the freshly-normalized canonical
   * AST. Debounced so a fast typist doesn't trigger a parse per
   * keystroke.
   */
  onAstChange?: (doc: CanonicalDocument) => void;
}

const DEBOUNCE_MS = 150;

const Editor: Component<EditorProps> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const fireAst = (source: string) => {
    if (!props.onAstChange) return;
    props.onAstChange(normalize(source));
  };

  const scheduleAst = (source: string) => {
    if (!props.onAstChange) return;
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      fireAst(source);
    }, DEBOUNCE_MS);
  };

  onMount(() => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      scheduleAst(update.state.doc.toString());
    });

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          updateListener,
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
        // The updateListener above will schedule the AST.
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    if (pending !== undefined) clearTimeout(pending);
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
