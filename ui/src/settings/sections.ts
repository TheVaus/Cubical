import type { Component } from "solid-js";

import type { IconName } from "@ds/components/graphics/Icon/Icon";

import type { InfoControl } from "./InfoButton";
import type { SettingsState } from "./settingsState";

export interface SettingsPaneProps {
  settings: SettingsState;
  info: InfoControl;
}

export interface SettingsSection {
  id: string;
  icon: IconName;
  label: string;
  order: number;
  pane: Component<SettingsPaneProps>;
}

const registry: SettingsSection[] = [];

export function registerSettingsSections(
  sections: readonly SettingsSection[],
): void {
  for (const section of sections) {
    if (!registry.some((s) => s.id === section.id)) registry.push(section);
  }
}

export function registeredSettingsSections(): readonly SettingsSection[] {
  return registry;
}
