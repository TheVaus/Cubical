import { createEffect, on, untrack } from "solid-js";

import type { Command } from "../core/commands";
import { corePluginEnabled } from "../settings/corePlugins";
import { canOpenTab, openTab, type TabSet } from "../tabs/tabModel";
import {
  GRAPH_COMMAND_ID,
  GRAPH_COMMAND_TITLE,
  GRAPH_PLUGIN,
} from "./registration";
import { GRAPH_TAB_ID, graphView, hasGraphTab } from "./tabView";

export interface GraphWiringDeps {
  vaultId: () => string | null;
  corePlugins: () => Record<string, boolean>;
  tabs: () => TabSet;
  setTabs: (updater: (s: TabSet) => TabSet) => void;
  closeTab: (id: string) => Promise<void>;
  flushAutosave: () => Promise<void>;
}

export interface GraphWiring {
  available: () => boolean;
  open: () => void;
  command: Command;
}

export function createGraphWiring(deps: GraphWiringDeps): GraphWiring {
  const enabled = () => corePluginEnabled(deps.corePlugins(), GRAPH_PLUGIN);

  createEffect(
    on(enabled, (on) => {
      if (on) return;
      if (!hasGraphTab(untrack(() => deps.tabs().tabs))) return;
      void deps.closeTab(GRAPH_TAB_ID);
    }),
  );

  const available = () => deps.vaultId() !== null && enabled();

  const open = () => {
    if (!available()) return;
    const view = graphView();
    if (!canOpenTab(deps.tabs(), view)) return;
    void (async () => {
      await deps.flushAutosave();
      deps.setTabs((s) => openTab(s, view));
    })();
  };

  return {
    available,
    open,
    command: {
      id: GRAPH_COMMAND_ID,
      title: GRAPH_COMMAND_TITLE,
      when: available,
      run: open,
    },
  };
}
