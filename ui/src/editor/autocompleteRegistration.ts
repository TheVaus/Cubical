import type { CorePlugin } from "../settings/corePlugins";

export const AUTOCOMPLETE_PLUGIN: CorePlugin = {
  id: "autocomplete",
  name: "Autocomplete",
  description:
    "Suggest note names, tags and block ids while typing [[, # or [[#^ in the editor.",
  settingKey: "plugins.autocomplete_enabled",
  defaultEnabled: true,
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.autocomplete_enabled": boolean;
  }
}
