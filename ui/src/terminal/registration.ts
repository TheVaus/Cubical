import type { BindingDefault } from "../core/commandRegistry";
import type { CorePlugin } from "../settings/corePlugins";

export const TERMINAL_PLUGIN: CorePlugin = {
  id: "terminal",
  name: "Terminal",
  description:
    "Run a real shell in a tab, rooted at the vault with cubical on its PATH.",
  settingKey: "plugins.terminal_enabled",
  defaultEnabled: false,
};

export const TERMINAL_COMMAND: BindingDefault = {
  id: "view.openTerminal",
  title: "Open terminal",
  scope: "global",
  defaultKey: "Mod-Shift-t",
  plugin: TERMINAL_PLUGIN.id,
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.terminal_enabled": boolean;
  }
}
