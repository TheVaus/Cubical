import { describe, expect, it } from "vitest";

import { emptyTabs, openTab, tabId } from "../tabs/tabModel";
import { GRAPH_TAB_ID, graphView, hasGraphTab, isGraphView } from "./tabView";

describe("graph tab view", () => {
  it("has a constant id, which is what makes it a singleton", () => {
    expect(tabId(graphView())).toBe("graph");
    expect(GRAPH_TAB_ID).toBe("graph");
  });

  it("recognises only the graph view", () => {
    expect(isGraphView(graphView())).toBe(true);
    expect(isGraphView({ kind: "file", path: "a.md" })).toBe(false);
    expect(isGraphView({ kind: "terminal", key: "1" })).toBe(false);
  });

  it("detects the graph tab in a tab set", () => {
    expect(hasGraphTab(emptyTabs.tabs)).toBe(false);
    const s = openTab(emptyTabs, graphView());
    expect(hasGraphTab(s.tabs)).toBe(true);
  });
});
