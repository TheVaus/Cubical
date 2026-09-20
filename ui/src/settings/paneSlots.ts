import type { Component } from "solid-js";

import type { SettingsPaneProps } from "./sections";
import type { SettingsTab } from "./tabs";

export interface PaneSlot {
  id: string;
  host: SettingsTab;
  order: number;
  pane: Component<SettingsPaneProps>;
}

const registry: PaneSlot[] = [];

export function registerPaneSlots(slots: readonly PaneSlot[]): void {
  for (const slot of slots) {
    if (!registry.some((s) => s.id === slot.id)) registry.push(slot);
  }
}

export function slotsFor(host: SettingsTab): PaneSlot[] {
  return registry
    .filter((slot) => slot.host === host)
    .sort((a, b) => a.order - b.order);
}
