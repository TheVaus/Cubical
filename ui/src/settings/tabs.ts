import type { IconName } from "@ds/components/graphics/Icon/Icon";

export type SettingsTab =
  | "appearance"
  | "editor"
  | "wikilinks"
  | "plugins"
  | "statusbar"
  | "vault"
  | "shortcuts";

export const SETTINGS_TABS: { id: SettingsTab; icon: IconName; label: string }[] =
  [
    { id: "appearance", icon: "palette", label: "Appearance" },
    { id: "editor", icon: "file-text", label: "Editor" },
    { id: "wikilinks", icon: "link", label: "Wiki links" },
    { id: "plugins", icon: "puzzle", label: "Plugins" },
    { id: "statusbar", icon: "bar-chart", label: "Status bar" },
    { id: "vault", icon: "library", label: "Vault" },
    { id: "shortcuts", icon: "keyboard", label: "Shortcuts" },
  ];
