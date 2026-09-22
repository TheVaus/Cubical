import type { CorePlugin } from "../settings/corePlugins";

export const INTEGRITY_PLUGIN: CorePlugin = {
  id: "integrity",
  name: "Link integrity",
  description:
    "List the vault's dangling links and reattach one to the note it meant.",
  settingKey: "plugins.integrity_enabled",
  defaultEnabled: true,
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.integrity_enabled": boolean;
  }
}
