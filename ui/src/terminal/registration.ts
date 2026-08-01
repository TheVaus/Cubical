import type { CorePlugin } from "../settings/corePlugins";

export const TERMINAL_PLUGIN: CorePlugin = {
  id: "terminal",
  name: "Terminal",
  description:
    "Run a real shell in a tab, rooted at the vault with cubical on its PATH.",
  settingKey: "plugins.terminal_enabled",
  defaultEnabled: false,
};

export const TERMINAL_COMMAND_ID = "view.openTerminal";

export const TERMINAL_COMMAND_TITLE = "Open terminal";
