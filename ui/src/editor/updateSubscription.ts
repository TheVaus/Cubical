import { onCleanup } from "solid-js";
import type { Extension, StateEffectType } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";

export interface UpdateSource {
  onUpdate(handler: () => void): () => void;
}

export type Subscribe = (
  source: UpdateSource | null | undefined,
  target: EditorView | undefined,
) => void;

export function createUpdateSubscriber(
  effect: StateEffectType<null>,
): Subscribe {
  let unsub: (() => void) | undefined;

  onCleanup(() => {
    unsub?.();
    unsub = undefined;
  });

  return (source, target) => {
    unsub?.();
    unsub =
      source && target
        ? source.onUpdate(() => {
            target.dispatch({ effects: effect.of(null) });
          })
        : undefined;
  };
}

export function updateSubscriptionExtension(
  source: UpdateSource | null | undefined,
  effect: StateEffectType<null>,
): Extension {
  if (!source) return [];
  return ViewPlugin.define((view) => {
    const unsub = source.onUpdate(() => {
      view.dispatch({ effects: effect.of(null) });
    });
    return { destroy: unsub };
  });
}
