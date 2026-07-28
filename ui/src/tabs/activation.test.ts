import { describe, expect, it } from "vitest";
import { activateWithFlush, type ActivationDeps } from "./activation";
import { activeTab, activateTab, emptyTabs, openTab, type TabSet } from "./tabModel";

function harness() {
  let tabs = activateTab(
    openTab(openTab(emptyTabs, { kind: "file", path: "a.md" }), {
      kind: "file",
      path: "b.md",
    }),
    "file:a.md",
  );
  let buffer = "";
  let dirty = false;
  const log: string[] = [];
  const writes: { path: string; content: string }[] = [];

  const deps: ActivationDeps = {
    current: () => tabs,
    flush: async () => {
      log.push("flush");
      if (!dirty) return;
      await Promise.resolve();
      const t = activeTab(tabs);
      if (t !== null && t.view.kind === "file") {
        writes.push({ path: t.view.path, content: buffer });
      }
      dirty = false;
    },
    setTabs: (fn: (s: TabSet) => TabSet) => {
      log.push("setTabs");
      tabs = fn(tabs);
    },
    resetDocState: () => {
      log.push("resetDocState");
      buffer = "";
    },
    loadContent: async () => {
      log.push("loadContent");
    },
  };

  return {
    deps,
    log,
    writes,
    edit: (content: string) => {
      buffer = content;
      dirty = true;
    },
    activeId: () => tabs.activeId,
  };
}

describe("activateWithFlush", () => {
  it("flushes to the originating tab's path before switching", async () => {
    const h = harness();
    h.edit("edited in a");
    await activateWithFlush(h.deps, "file:b.md");
    expect(h.writes).toEqual([{ path: "a.md", content: "edited in a" }]);
  });

  it("never writes the previous tab's buffer to the newly activated path", async () => {
    const h = harness();
    h.edit("edited in a");
    await activateWithFlush(h.deps, "file:b.md");
    expect(h.writes.some((w) => w.path === "b.md")).toBe(false);
  });

  it("runs flush, reset, switch, load in exactly that order", async () => {
    const h = harness();
    h.edit("edited in a");
    await activateWithFlush(h.deps, "file:b.md");
    expect(h.log).toEqual(["flush", "resetDocState", "setTabs", "loadContent"]);
  });

  it("loads content only after the tab set has switched", async () => {
    const h = harness();
    await activateWithFlush(h.deps, "file:b.md");
    expect(h.log.indexOf("setTabs")).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf("setTabs")).toBeLessThan(h.log.indexOf("loadContent"));
    expect(h.activeId()).toBe("file:b.md");
  });

  it("is a no-op when the tab is already active", async () => {
    const h = harness();
    await activateWithFlush(h.deps, "file:a.md");
    expect(h.log).toEqual([]);
  });

  it("does not write when nothing was edited", async () => {
    const h = harness();
    await activateWithFlush(h.deps, "file:b.md");
    expect(h.writes).toEqual([]);
  });

  it("is a no-op for an id that is not in the tab set", async () => {
    const h = harness();
    h.edit("edited in a");
    await activateWithFlush(h.deps, "file:missing.md");
    expect(h.log).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.activeId()).toBe("file:a.md");
  });
});
