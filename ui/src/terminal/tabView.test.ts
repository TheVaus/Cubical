import { describe, expect, it } from "vitest";

import { isPersistableTab, openTab, tabId, emptyTabs } from "../tabs/tabModel";
import { isTerminalView, terminalTabId, terminalTabIds, terminalView } from "./tabView";

describe("terminal tab views", () => {
  it("gives every terminal its own id, so terminals are not a singleton", () => {
    expect(terminalTabId("1")).toBe("terminal:1");
    expect(terminalTabId("2")).toBe("terminal:2");
    expect(tabId(terminalView("7"))).toBe("terminal:7");
  });

  it("opens side by side rather than reactivating one tab", () => {
    const s = openTab(openTab(emptyTabs, terminalView("1")), terminalView("2"));

    expect(s.tabs.map((t) => t.id)).toEqual(["terminal:1", "terminal:2"]);
    expect(s.activeId).toBe("terminal:2");
  });

  it("recognises only terminal views", () => {
    expect(isTerminalView(terminalView("1"))).toBe(true);
    expect(isTerminalView({ kind: "console" })).toBe(false);
    expect(isTerminalView({ kind: "file", path: "a.md" })).toBe(false);
  });

  it("lists the terminal tabs and nothing else", () => {
    const s = openTab(
      openTab(openTab(emptyTabs, { kind: "file", path: "a.md" }), terminalView("1")),
      { kind: "console" },
    );

    expect(terminalTabIds(s.tabs)).toEqual(["terminal:1"]);
  });

  it("is never persisted — a restored terminal tab would be a dead process", () => {
    const s = openTab(openTab(emptyTabs, { kind: "file", path: "a.md" }), terminalView("1"));

    expect(s.tabs.filter(isPersistableTab).map((t) => t.id)).toEqual(["file:a.md"]);
  });
});
