import { tabId, type Tab, type TabView } from "../tabs/tabModel";

export function graphView(): TabView {
  return { kind: "graph" };
}

export const GRAPH_TAB_ID = tabId(graphView());

export function isGraphView(view: TabView): boolean {
  return view.kind === "graph";
}

export function hasGraphTab(tabs: Tab[]): boolean {
  return tabs.some((t) => isGraphView(t.view));
}
