import { GRAPH_PLUGIN } from "../graph/registration";
import { TERMINAL_PLUGIN } from "../terminal/registration";
import type { Setting } from "../api/ipc";

export type BooleanSettingKey = Extract<Setting, { value: boolean }>["key"];

export type PluginDocId = "query" | "property-refs" | "math";

export interface CorePlugin {
  id: string;
  name: string;
  description: string;
  settingKey: BooleanSettingKey;
  defaultEnabled: boolean;
  docId?: PluginDocId;
}

export const CORE_PLUGINS: CorePlugin[] = [
  {
    id: "dataview",
    name: "Query",
    description:
      "Turn a ```query block into a live table, list, or count of notes, built from tags, folders, and frontmatter.",
    settingKey: "plugins.dataview_enabled",
    defaultEnabled: true,
    docId: "query",
  },
  {
    id: "property-refs",
    name: "Property references",
    description:
      "Show a frontmatter value inline: [[note.prop]] pulls from another note, [[.prop]] from this one.",
    settingKey: "plugins.property_refs_enabled",
    defaultEnabled: true,
    docId: "property-refs",
  },
  {
    id: "math",
    name: "Math",
    description:
      "Typeset LaTeX with KaTeX — ```math blocks and $$…$$ display math render as you write.",
    settingKey: "plugins.math_enabled",
    defaultEnabled: true,
    docId: "math",
  },
  TERMINAL_PLUGIN,
  GRAPH_PLUGIN,
];

export function corePluginEnabled(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): boolean {
  return state[plugin.id] ?? plugin.defaultEnabled;
}

export function corePluginOn(
  state: Record<string, boolean>,
  id: string,
): boolean {
  const plugin = CORE_PLUGINS.find((p) => p.id === id);
  return plugin ? corePluginEnabled(state, plugin) : false;
}
