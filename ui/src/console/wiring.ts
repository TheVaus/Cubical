import { createEffect } from "solid-js";

import type { Command } from "../core/commands";
import { corePluginEnabled } from "../settings/corePlugins";
import { openTab, type TabSet } from "../tabs/tabModel";
import {
  CONSOLE_COMMAND_ID,
  CONSOLE_COMMAND_TITLE,
  CONSOLE_PLUGIN,
} from "./registration";
import { CONSOLE_TAB_ID, CONSOLE_VIEW } from "./tabView";

export interface ConsoleWiringDeps {
  vaultId: () => string | null;
  corePlugins: () => Record<string, boolean>;
  tabs: () => TabSet;
  setTabs: (updater: (s: TabSet) => TabSet) => void;
  closeTab: (id: string) => Promise<void>;
  flushAutosave: () => Promise<void>;
}

export interface ConsoleWiring {
  available: () => boolean;
  open: () => void;
  command: Command;
}

export function createConsoleWiring(deps: ConsoleWiringDeps): ConsoleWiring {
  const enabled = () => corePluginEnabled(deps.corePlugins(), CONSOLE_PLUGIN);

  createEffect(() => {
    if (!enabled() && deps.tabs().tabs.some((t) => t.id === CONSOLE_TAB_ID)) {
      void deps.closeTab(CONSOLE_TAB_ID);
    }
  });

  const available = () => deps.vaultId() !== null && enabled();
  const open = () => {
    void (async () => {
      await deps.flushAutosave();
      deps.setTabs((s) => openTab(s, CONSOLE_VIEW));
    })();
  };

  return {
    available,
    open,
    command: {
      id: CONSOLE_COMMAND_ID,
      title: CONSOLE_COMMAND_TITLE,
      when: available,
      run: open,
    },
  };
}
