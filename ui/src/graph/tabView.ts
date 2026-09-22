import type { TabKind } from "../tabs/tabKinds";
import { tabId, type Tab, type TabView } from "../tabs/tabModel";

export const GRAPH_TAB_KIND: TabKind = {
  kind: "graph",
  label: () => "Graph",
  evictable: false,
};

export function graphView(): TabView {
  return { kind: GRAPH_TAB_KIND.kind, key: "" };
}

export const GRAPH_TAB_ID = tabId(graphView());

export function isGraphView(view: TabView): boolean {
  return view.kind === GRAPH_TAB_KIND.kind;
}

export function hasGraphTab(tabs: Tab[]): boolean {
  return tabs.some((t) => isGraphView(t.view));
}
