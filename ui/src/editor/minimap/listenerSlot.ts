import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

const slot = new Compartment();

export function attachUpdateListener(
  view: EditorView,
  handler: (update: ViewUpdate) => void,
): () => void {
  const listener = EditorView.updateListener.of(handler);
  view.dispatch({
    effects:
      slot.get(view.state) === undefined
        ? StateEffect.appendConfig.of(slot.of(listener))
        : slot.reconfigure(listener),
  });
  return () => view.dispatch({ effects: slot.reconfigure([]) });
}
