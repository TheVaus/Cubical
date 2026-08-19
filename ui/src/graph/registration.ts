import type { CorePlugin } from "../settings/corePlugins";

export const GRAPH_PLUGIN: CorePlugin = {
  id: "graph-view",
  name: "Graph view",
  description:
    "Show the vault as a knowledge graph — notes as nodes, links as edges.",
  settingKey: "plugins.graph_view_enabled",
  defaultEnabled: true,
};

export const GRAPH_COMMAND_ID = "graph.open";

export const GRAPH_COMMAND_TITLE = "Open graph view";
