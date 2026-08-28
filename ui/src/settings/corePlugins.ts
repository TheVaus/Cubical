import { GRAPH_PLUGIN } from "../graph/registration";
import { TERMINAL_PLUGIN } from "../terminal/registration";
import type { Setting } from "../api/ipc";

export type BooleanSettingKey = Extract<Setting, { value: boolean }>["key"];

export type PluginDocId = "query" | "property-refs" | "math" | "equations";

export interface CorePlugin {
  id: string;
  name: string;
  description: string;
  settingKey: BooleanSettingKey;
  defaultEnabled: boolean;
  docId?: PluginDocId;
  requires?: readonly string[];
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
  {
    id: "equations",
    name: "Equations",
    description:
      "Compute inside a note: `= 5-3` renders 2, and an operand can be a property from any note.",
    settingKey: "plugins.equations_enabled",
    defaultEnabled: true,
    docId: "equations",
    requires: ["property-refs"],
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

export function missingRequirements(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): CorePlugin[] {
  return (plugin.requires ?? [])
    .filter((id) => !corePluginOn(state, id))
    .flatMap((id) => CORE_PLUGINS.filter((p) => p.id === id));
}

export function corePluginAvailable(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): boolean {
  return missingRequirements(state, plugin).length === 0;
}

export function corePluginOn(
  state: Record<string, boolean>,
  id: string,
): boolean {
  const plugin = CORE_PLUGINS.find((p) => p.id === id);
  return plugin ? corePluginEnabled(state, plugin) : false;
}

export function corePluginActive(
  state: Record<string, boolean>,
  id: string,
): boolean {
  const plugin = CORE_PLUGINS.find((p) => p.id === id);
  return plugin
    ? corePluginEnabled(state, plugin) && corePluginAvailable(state, plugin)
    : false;
}
