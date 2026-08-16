import { describe, expect, it } from "vitest";
import {
  activateTab,
  activeTab,
  canOpenTab,
  clampTabs,
  closeTab,
  dropMissingTabs,
  emptyTabs,
  moveTab,
  nextTab,
  MAX_TABS,
  openTab,
  prevTab,
  remapTabPaths,
  tabId,
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

  it("stops appending at MAX_TABS", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS + 4; i++) s = openTab(s, fileView(`n${i}.md`));
    expect(s.tabs).toHaveLength(MAX_TABS);
  });

  it("replaces the active tab in place once at the cap", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS; i++) s = openTab(s, fileView(`n${i}.md`));
    s = activateTab(s, "file:n2.md");

    s = openTab(s, fileView("new.md"));

    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:new.md");
    expect(s.tabs[2]?.id).toBe("file:new.md");
    expect(s.tabs.map((t) => t.id)).not.toContain("file:n2.md");
    expect(s.tabs[1]?.id).toBe("file:n1.md");
    expect(s.tabs[3]?.id).toBe("file:n3.md");
  });

  it("activates an already-open tab at the cap instead of replacing", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS; i++) s = openTab(s, fileView(`n${i}.md`));
    s = openTab(s, fileView("n0.md"));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:n0.md");
  });

  it("never replaces a terminal tab, so a live session is not killed", () => {
    let s = emptyTabs;
    s = openTab(s, { kind: "terminal", key: "1" });
    for (let i = 0; i < MAX_TABS - 1; i++) s = openTab(s, fileView(`n${i}.md`));
    s = activateTab(s, "terminal:1");

    s = openTab(s, fileView("new.md"));

    expect(s.tabs.map((t) => t.id)).toContain("terminal:1");
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:new.md");
    expect(s.tabs.at(-1)?.id).toBe("file:new.md");
  });

  it("leaves a slot a file can always take, however many terminals are opened", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS + 6; i++)
      s = openTab(s, { kind: "terminal", key: String(i) });

    expect(s.tabs).toHaveLength(MAX_TABS - 1);

    s = openTab(s, fileView("new.md"));

    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:new.md");
  });

  it("refuses a terminal that would leave no replaceable slot", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS - 1; i++)
      s = openTab(s, { kind: "terminal", key: String(i) });

    const refused = openTab(s, { kind: "terminal", key: "extra" });

    expect(refused).toBe(s);
    expect(canOpenTab(s, { kind: "terminal", key: "extra" })).toBe(false);
  });

  it("still opens a file at the cap when every other tab is a terminal", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS - 1; i++)
      s = openTab(s, { kind: "terminal", key: String(i) });
    s = openTab(s, fileView("only.md"));

    expect(canOpenTab(s, fileView("new.md"))).toBe(true);
    s = openTab(s, fileView("new.md"));

    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:new.md");
    expect(s.tabs.map((t) => t.id)).not.toContain("file:only.md");
  });

  it("reports an already-open tab as openable even with no free slot", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS - 1; i++)
      s = openTab(s, { kind: "terminal", key: String(i) });
    expect(canOpenTab(s, { kind: "terminal", key: "0" })).toBe(true);
  });
});

describe("clampTabs", () => {
  const of = (n: number) => {
    let s = emptyTabs;
    for (let i = 0; i < n; i++) s = openTab(s, fileView(`n${i}.md`), n);
    return s;
  };

  it("leaves a set within the cap untouched", () => {
    const s = of(MAX_TABS);
    expect(clampTabs(s)).toEqual(s);
  });

  it("trims an oversized set down to the cap", () => {
    const s = clampTabs(of(MAX_TABS + 5));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs[0]!.id).toBe("file:n0.md");
  });

  it("keeps the active tab when it falls outside the surviving slice", () => {
    const s = clampTabs(activateTab(of(MAX_TABS + 5), "file:n10.md"));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:n10.md");
    expect(s.tabs.map((t) => t.id)).toContain("file:n10.md");
  });

  it("keeps the active tab sitting exactly on the cap boundary", () => {
    const s = clampTabs(activateTab(of(MAX_TABS + 5), `file:n${MAX_TABS}.md`));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe(`file:n${MAX_TABS}.md`);
    expect(s.tabs.at(-1)!.id).toBe(`file:n${MAX_TABS}.md`);
    expect(s.tabs[MAX_TABS - 2]!.id).toBe(`file:n${MAX_TABS - 2}.md`);
  });

  it("keeps the last tab of an oversized set when it is active", () => {
    const n = MAX_TABS + 5;
    const s = clampTabs(activateTab(of(n), `file:n${n - 1}.md`));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe(`file:n${n - 1}.md`);
  });

  it("reactivates when the set had no valid active tab", () => {
    const s = clampTabs({ ...of(MAX_TABS + 5), activeId: "file:gone.md" });
    expect(s.activeId).toBe("file:n0.md");
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

describe("remapTabPaths", () => {
  it("rewrites a renamed path and its id, keeping the tab active", () => {
    let s = openTab(emptyTabs, fileView("a.md"));
    s = remapTabPaths(s, (p) => (p === "a.md" ? "b.md" : null));
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.id).toBe("file:b.md");
    expect(s.tabs[0]!.view).toEqual(fileView("b.md"));
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
