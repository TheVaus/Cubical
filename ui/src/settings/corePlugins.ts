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

export const BUILTIN_PLUGINS: readonly CorePlugin[] = [
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
];

const registry: CorePlugin[] = [...BUILTIN_PLUGINS];

export function registerCorePlugins(plugins: readonly CorePlugin[]): void {
  for (const plugin of plugins) {
    if (!registry.some((p) => p.id === plugin.id)) registry.push(plugin);
  }
}

export function registeredCorePlugins(): readonly CorePlugin[] {
  return registry;
}

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
  return (plugin.requires ?? []).flatMap((id) =>
    registry.filter((p) => p.id === id && !corePluginEnabled(state, p)),
  );
}

export function corePluginActive(
  state: Record<string, boolean>,
  target: CorePlugin | string,
): boolean {
  const plugin =
    typeof target === "string"
      ? registry.find((p) => p.id === target)
      : target;
  if (!plugin) return false;
  return (
    corePluginEnabled(state, plugin) &&
    missingRequirements(state, plugin).length === 0
  );
}
