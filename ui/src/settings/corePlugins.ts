import { TERMINAL_PLUGIN } from "../terminal/registration";
import type { Setting } from "../api/ipc";

export type BooleanSettingKey = Extract<Setting, { value: boolean }>["key"];

export interface CorePlugin {
  id: string;
  name: string;
  description: string;
  settingKey: BooleanSettingKey;
  defaultEnabled: boolean;
}

export const CORE_PLUGINS: CorePlugin[] = [
  {
    id: "dataview",
    name: "Dataview",
    description: "Render ```query blocks as live tables, lists, and counts.",
    settingKey: "plugins.dataview_enabled",
    defaultEnabled: true,
  },
  {
    id: "property-refs",
    name: "Property references",
    description:
      "Render [[note.prop]] / [[.prop]] as inline frontmatter values.",
    settingKey: "plugins.property_refs_enabled",
    defaultEnabled: true,
  },
  {
    id: "math",
    name: "Math",
    description:
      "Typeset ```math blocks and $$…$$ display math with KaTeX.",
    settingKey: "plugins.math_enabled",
    defaultEnabled: true,
  },
  TERMINAL_PLUGIN,
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
