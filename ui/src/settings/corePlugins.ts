import type { Setting } from "../api/ipc";

/** Setting keys whose value is a boolean — the only keys a toggle can bind. */
export type BooleanSettingKey = Extract<Setting, { value: boolean }>["key"];

export interface CorePlugin {
  /** Stable id, also the enablement-map key. */
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
];

/** Resolve a plugin's on/off state: the stored value, else its default. */
export function corePluginEnabled(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): boolean {
  return state[plugin.id] ?? plugin.defaultEnabled;
}
