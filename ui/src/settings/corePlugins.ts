import { CONSOLE_PLUGIN } from "../console/registration";
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
  CONSOLE_PLUGIN,
  TERMINAL_PLUGIN,
];

export function corePluginEnabled(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): boolean {
  return state[plugin.id] ?? plugin.defaultEnabled;
}
