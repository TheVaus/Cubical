import { Match, Switch, createEffect, on, type JSXElement } from "solid-js";

import Callout from "@ds/components/feedback/Callout/Callout";

import { createGraphState } from "./graphState";
import "./graph.css";

export function GraphView(props: { vaultId: () => string | null }): JSXElement {
  const state = createGraphState({ vaultId: props.vaultId });

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
    </div>
  );
}
