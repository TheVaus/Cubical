import type { CorePlugin } from "../settings/corePlugins";

export const SEARCH_PLUGIN: CorePlugin = {
  id: "search",
  name: "Search",
  description:
    "Full-text search over the vault, with field scopes, fuzzy matching and recency sort.",
  settingKey: "plugins.search_enabled",
  defaultEnabled: true,
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.search_enabled": boolean;
  }
}
