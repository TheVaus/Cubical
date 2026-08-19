import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  type JSXElement,
} from "solid-js";

import Callout from "@ds/components/feedback/Callout/Callout";

import { GraphCanvas } from "./GraphCanvas";
import { createGraphState } from "./graphState";
import { GraphFilters } from "./GraphFilters";
import {
  DEFAULT_FILTER,
  countVisible,
  nodeAt,
  openablePath,
  visibleNodes,
  type GraphViewFilter,
} from "./graphModel";
import "./graph.css";

export function GraphView(props: {
  vaultId: () => string | null;
  theme: () => string;
  onOpenFile: (path: string) => void;
}): JSXElement {
  const state = createGraphState({ vaultId: props.vaultId });
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [hoverAt, setHoverAt] = createSignal<[number, number] | null>(null);
  const [filter, setFilter] = createSignal<GraphViewFilter>(DEFAULT_FILTER);

  const visible = createMemo(() => visibleNodes(state.snapshot(), filter()));

  const hoveredNode = () => nodeAt(state.snapshot(), hovered());

  const labelStyle = () => {
    const at = hoverAt();
    if (at === null) return {};
    const dpr = window.devicePixelRatio || 1;
    return {
      left: `${at[0] / dpr}px`,
      top: `${at[1] / dpr}px`,
    };
  };

  const activate = (index: number) => {
    const path = openablePath(nodeAt(state.snapshot(), index));
    if (path !== null) props.onOpenFile(path);
  };

  createEffect(on(props.vaultId, () => state.start()));

  const counts = () => {
    const snap = state.snapshot();
    return snap === null ? null : { nodes: snap.nodes.length, edges: snap.edges.length };
  };

  return (
    <div class="graph" role="region" aria-label="Graph view">
      <Switch>
        <Match when={state.status() === "error"}>
          <Callout tone="warning" title="The graph could not be built">
            {state.error()}
          </Callout>
        </Match>
        <Match when={state.status() === "loading"}>
          <p class="graph__status">Reading the vault graph…</p>
        </Match>
        <Match when={state.status() === "laying-out"}>
          <p class="graph__status">
            Laying out {counts()?.nodes ?? 0} nodes — iteration {state.iteration()}
          </p>
        </Match>
        <Match when={state.status() === "ready"}>
          <p class="graph__status">
            {counts()?.nodes ?? 0} nodes, {counts()?.edges ?? 0} edges
          </p>
        </Match>
      </Switch>
      <Show when={state.snapshot() !== null}>
        <GraphCanvas
          snapshot={state.snapshot}
          positions={state.positions}
          theme={props.theme}
          visible={visible}
          onHover={(node, screen) => {
            setHovered(node);
            setHoverAt(screen);
          }}
          onActivate={activate}
        />
        <GraphFilters
          filter={filter}
          setFilter={setFilter}
          visible={() => countVisible(visible())}
          total={() => state.snapshot()?.nodes.length ?? 0}
        />
        <Show when={hoveredNode()}>
          {(node) => (
            <div class="graph__hover" role="status" style={labelStyle()}>
              <span class="graph__hover-label">{node().label}</span>
              <span class="graph__hover-kind">{node().kind}</span>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
