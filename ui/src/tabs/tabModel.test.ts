import { describe, expect, it } from "vitest";
import { navPush } from "../navHistory";
import {
  activateTab,
  activeTab,
  closeTab,
  dropMissingTabs,
  emptyTabs,
  moveTab,
  nextTab,
  openTab,
  prevTab,
  remapTabPaths,
  tabId,
  updateNav,
} from "./tabModel";

const fileView = (path: string) => ({ kind: "file" as const, path });

describe("tabId", () => {
  it("derives distinct ids per view kind", () => {
    expect(tabId(fileView("a.md"))).toBe("file:a.md");
    expect(tabId({ kind: "tag", tagPath: "work" })).toBe("tag:work");
  });
});

describe("openTab", () => {
  it("appends a tab and activates it", () => {
    const s = openTab(emptyTabs, fileView("a.md"));
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe("file:a.md");
    expect(activeTab(s)?.view).toEqual(fileView("a.md"));
  });

  it("activates the existing tab instead of duplicating it", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = openTab(s, fileView("a.md"));
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe("file:a.md");
  });

  it("does not mutate the input", () => {
    const before = openTab(emptyTabs, fileView("a.md"));
    const snapshot = JSON.stringify(before);
    openTab(before, fileView("b.md"));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("closeTab", () => {
  it("activates the right-hand neighbour", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = openTab(s, fileView("c.md"));
    s = activateTab(s, "file:b.md");
    s = closeTab(s, "file:b.md");
    expect(s.activeId).toBe("file:c.md");
  });

  it("falls back to the left-hand neighbour when closing the last tab", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = closeTab(s, "file:b.md");
    expect(s.activeId).toBe("file:a.md");
  });

  it("leaves activeId null when the set empties", () => {
    const s = closeTab(openTab(emptyTabs, fileView("a.md")), "file:a.md");
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("keeps the active tab when closing a different one", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = closeTab(s, "file:a.md");
    expect(s.activeId).toBe("file:b.md");
  });
});

describe("nextTab / prevTab", () => {
  it("wraps around in both directions", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    expect(nextTab(s).activeId).toBe("file:a.md");
    expect(prevTab(activateTab(s, "file:a.md")).activeId).toBe("file:b.md");
  });

  it("is a no-op on an empty set", () => {
    expect(nextTab(emptyTabs).activeId).toBeNull();
  });
});

describe("moveTab", () => {
  it("reorders without changing the active tab", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = moveTab(s, "file:a.md", 1);
    expect(s.tabs.map((t) => t.id)).toEqual(["file:b.md", "file:a.md"]);
    expect(s.activeId).toBe("file:b.md");
  });
});

describe("updateNav", () => {
  it("updates only the addressed tab's history", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = updateNav(s, "file:a.md", (n) => navPush(n, "a.md"));
    expect(s.tabs[0]!.nav.stack).toEqual(["a.md"]);
    expect(s.tabs[1]!.nav.stack).toEqual([]);
  });
});

describe("remapTabPaths", () => {
  it("rewrites a renamed path and its id, preserving nav history", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = updateNav(s, "file:a.md", (n) => navPush(n, "a.md"));
    s = remapTabPaths(s, (p) => (p === "a.md" ? "b.md" : null));
    expect(s.tabs[0]!.id).toBe("file:b.md");
    expect(s.tabs[0]!.view).toEqual(fileView("b.md"));
    expect(s.tabs[0]!.nav.stack).toEqual(["a.md"]);
    expect(s.activeId).toBe("file:b.md");
  });

  it("drops a tab that collides with an existing one after remapping", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = remapTabPaths(s, (p) => (p === "a.md" ? "b.md" : null));
    expect(s.tabs.map((t) => t.id)).toEqual(["file:b.md"]);
  });

  it("leaves tag tabs alone", () => {
    const s = remapTabPaths(
      openTab(emptyTabs, { kind: "tag", tagPath: "work" }),
      () => "other.md",
    );
    expect(s.tabs[0]!.id).toBe("tag:work");
  });
});

describe("dropMissingTabs", () => {
  it("removes file tabs whose path is gone and reactivates", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = openTab(s, fileView("b.md"));
    s = dropMissingTabs(s, (p) => p === "a.md");
    expect(s.tabs.map((t) => t.id)).toEqual(["file:a.md"]);
    expect(s.activeId).toBe("file:a.md");
  });

  it("never drops tag tabs", () => {
    const s = dropMissingTabs(
      openTab(emptyTabs, { kind: "tag", tagPath: "work" }),
      () => false,
    );
    expect(s.tabs).toHaveLength(1);
  });
});
