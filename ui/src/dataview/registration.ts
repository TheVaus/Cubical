import type { CorePlugin } from "../settings/corePlugins";

export const QUERY_PLUGIN: CorePlugin = {
  id: "dataview",
  name: "Query",
  description:
    "Turn a ```query block into a live table, list, or count of notes, built from tags, folders, and frontmatter.",
  settingKey: "plugins.dataview_enabled",
  defaultEnabled: true,
  docId: "query",
};
