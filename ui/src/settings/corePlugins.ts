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

const registry: CorePlugin[] = [];

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
