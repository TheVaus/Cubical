import type { IconName } from "@ds/components/graphics/Icon/Icon";

import { registeredSettingsSections } from "./sections";

export type SettingsTab =
  | "appearance"
  | "editor"
  | "wikilinks"
  | "plugins"
  | "vault"
  | "shortcuts";

export interface SettingsNavItem {
  id: string;
  icon: IconName;
  label: string;
  order: number;
}

export const SETTINGS_TABS: SettingsNavItem[] = [
  { id: "appearance", icon: "palette", label: "Appearance", order: 10 },
  { id: "editor", icon: "file-text", label: "Editor", order: 20 },
  { id: "wikilinks", icon: "link", label: "Wiki links", order: 30 },
  { id: "plugins", icon: "puzzle", label: "Plugins", order: 40 },
  { id: "vault", icon: "library", label: "Vault", order: 60 },
  { id: "shortcuts", icon: "keyboard", label: "Shortcuts", order: 70 },
];

export function settingsNav(): { id: string; icon: IconName; label: string }[] {
  return [...SETTINGS_TABS, ...registeredSettingsSections()]
    .sort((a, b) => a.order - b.order)
    .map(({ id, icon, label }) => ({ id, icon, label }));
}
