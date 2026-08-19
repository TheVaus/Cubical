import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSXElement,
} from "solid-js";

import Callout from "@ds/components/feedback/Callout/Callout";

import type { GraphSnapshot } from "../api/ipc";
import { createGraphRenderLoop } from "./renderLoop";

export function GraphCanvas(props: {
  snapshot: () => GraphSnapshot | null;
  positions: () => Float32Array;
  theme: () => string;
  visible: () => Uint8Array;
  onHover: (node: number | null) => void;
  onActivate: (node: number) => void;
}): JSXElement {
  let canvas!: HTMLCanvasElement;
  let host!: HTMLDivElement;
  const [failure, setFailure] = createSignal<string | null>(null);

  onMount(() => {
    const loop = createGraphRenderLoop({
      canvas,
      host,
      snapshot: props.snapshot,
      positions: props.positions,
      theme: props.theme,
      visible: props.visible,
      onFailure: setFailure,
      onHover: props.onHover,
      onActivate: props.onActivate,
    });
    createEffect(() => {
      props.positions();
      props.theme();
      loop.request();
    });
    createEffect(() => {
      props.visible();
      loop.refilter();
    });
    onCleanup(loop.destroy);
  });

  return (
    <div class="graph__canvas-host" ref={host}>
      <canvas class="graph__canvas" ref={canvas} />
      <Show when={failure()}>
        {(message) => (
          <div class="graph__fallback">
            <Callout tone="warning" title="Graph view needs WebGPU">
              {message()}
            </Callout>
          </div>
        )}
      </Show>
    </div>
  );
}
