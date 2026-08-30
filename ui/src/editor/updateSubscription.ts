import { onCleanup } from "solid-js";
import type { StateEffectType } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

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
