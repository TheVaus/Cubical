import { afterEach, describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";

import { closeTab, emptyTabs, MAX_TABS, openTab, type TabSet } from "../tabs/tabModel";
import { createGraphWiring, type GraphWiring } from "./wiring";
import { GRAPH_TAB_ID } from "./tabView";

const flush = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

interface Harness {
  wiring: GraphWiring;
  tabs: () => TabSet;
  setEnabled: (on: boolean) => void;
  setVaultId: (id: string | null) => void;
  setTabs: (updater: (s: TabSet) => TabSet) => void;
  closed: string[];
}

function harness(opts?: { enabled?: boolean; vaultId?: string | null }): Harness {
  let h!: Harness;
  dispose = createRoot((d) => {
    const [enabled, setEnabled] = createSignal(opts?.enabled ?? true);
    const [vaultId, setVaultId] = createSignal<string | null>(
      opts?.vaultId === undefined ? "v1" : opts.vaultId,
    );
    const [tabs, setTabs] = createSignal<TabSet>(emptyTabs);
    const closed: string[] = [];
    const wiring = createGraphWiring({
      vaultId,
      corePlugins: () => ({ "graph-view": enabled() }),
      tabs,
      setTabs: (updater) => setTabs((s) => updater(s)),
      closeTab: async (id) => {
        closed.push(id);
        setTabs((s) => closeTab(s, id));
      },
      flushAutosave: async () => {},
    });
    h = {
      wiring,
      tabs,
      setEnabled,
      setVaultId,
      setTabs: (updater) => setTabs((s) => updater(s)),
      closed,
    };
    return d;
  });
  return h;
}

describe("graph wiring", () => {
  it("is unavailable without a vault", () => {
    const h = harness({ vaultId: null });
    expect(h.wiring.available()).toBe(false);
  });

  it("is unavailable when the plugin is off", () => {
    const h = harness({ enabled: false });
    expect(h.wiring.available()).toBe(false);
  });

  it("is available by default with a vault open", () => {
    const h = harness();
    expect(h.wiring.available()).toBe(true);
  });

  it("opens one graph tab and focuses it again on a second open", async () => {
    const h = harness();
    h.wiring.open();
    await flush();
    h.wiring.open();
    await flush();

    expect(h.tabs().tabs.filter((t) => t.view.kind === "graph")).toHaveLength(1);
    expect(h.tabs().activeId).toBe(GRAPH_TAB_ID);
  });

  it("does not open when there is no vault", async () => {
    const h = harness({ vaultId: null });
    h.wiring.open();
    await flush();
    expect(h.tabs().tabs).toHaveLength(0);
  });

  it("closes the graph tab when the plugin is switched off", async () => {
    const h = harness();
    h.wiring.open();
    await flush();
    expect(h.tabs().tabs).toHaveLength(1);

    h.setEnabled(false);
    await flush();

    expect(h.closed).toEqual([GRAPH_TAB_ID]);
    expect(h.tabs().tabs).toHaveLength(0);
  });

  it("leaves the tab alone when the plugin is switched on", async () => {
    const h = harness({ enabled: false });
    h.setEnabled(true);
    await flush();
    expect(h.closed).toEqual([]);
  });

  it("is refused rather than replacing a tab when no slot is free", async () => {
    const h = harness();
    for (let i = 0; i < MAX_TABS - 1; i++) {
      h.setTabs((s) => openTab(s, { kind: "terminal", key: String(i) }));
    }
    h.wiring.open();
    await flush();

    expect(h.tabs().tabs.some((t) => t.view.kind === "graph")).toBe(false);
  });

  it("exposes a command that is gated on the same availability", () => {
    const h = harness({ enabled: false });
    expect(h.wiring.command.id).toBe("graph.open");
    expect(h.wiring.command.when?.()).toBe(false);
    h.setEnabled(true);
    expect(h.wiring.command.when?.()).toBe(true);
  });
});
