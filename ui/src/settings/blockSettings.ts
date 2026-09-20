import type { Setting, SettingValue } from "../api/ipc";

export type SettingKey = Setting["key"];

export interface BlockSetting {
  key: SettingKey;
  fallback: Setting["value"];
}

export function blockSetting<K extends SettingKey>(
  key: K,
  fallback: SettingValue<K>,
): BlockSetting {
  return { key, fallback };
}

const registry: BlockSetting[] = [];

export function registerBlockSettings(
  settings: readonly BlockSetting[],
): void {
  for (const setting of settings) {
    if (!registry.some((s) => s.key === setting.key)) registry.push(setting);
  }
}

export function registeredBlockSettings(): readonly BlockSetting[] {
  return registry;
}

export function fallbackFor(key: SettingKey): Setting["value"] | undefined {
  return registry.find((s) => s.key === key)?.fallback;
}
