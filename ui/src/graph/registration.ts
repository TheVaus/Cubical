import type { BindingDefault } from "../core/commandRegistry";
import type { CorePlugin } from "../settings/corePlugins";

export const GRAPH_PLUGIN: CorePlugin = {
  id: "graph-view",
  name: "Graph view",
  description:
    "Show the vault as a knowledge graph — notes as nodes, links as edges.",
  settingKey: "plugins.graph_view_enabled",
  defaultEnabled: true,
};

export const GRAPH_COMMAND: BindingDefault = {
  id: "graph.open",
  title: "Open graph view",
  scope: "global",
  defaultKey: "Mod-Shift-g",
  plugin: GRAPH_PLUGIN.id,
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.graph_view_enabled": boolean;
  }
}
