import { Show, type JSXElement } from "solid-js";

import type { TabSet } from "../tabs/tabModel";
import { GraphView } from "./GraphView";
import { GRAPH_TAB_ID, hasGraphTab } from "./tabView";

export function GraphTabPane(props: {
  vaultId: () => string | null;
  tabs: () => TabSet;
  theme: () => string;
  onOpenFile: (path: string) => void;
}): JSXElement {
  return (
    <Show when={hasGraphTab(props.tabs().tabs)}>
      <div
        style={{
          display: props.tabs().activeId === GRAPH_TAB_ID ? "contents" : "none",
        }}
      >
        <GraphView vaultId={props.vaultId} theme={props.theme} onOpenFile={props.onOpenFile} />
      </div>
    </Show>
  );
}
