import type { CorePlugin } from "../settings/corePlugins";

export const CONSOLE_PLUGIN: CorePlugin = {
  id: "console",
  name: "Command console",
  description: "Run cubical commands against the open vault in a tab.",
  settingKey: "plugins.console_enabled",
  defaultEnabled: false,
};

export const CONSOLE_COMMAND_ID = "view.openConsole";

export const CONSOLE_COMMAND_TITLE = "Open command console";
