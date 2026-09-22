import type { CorePlugin } from "../settings/corePlugins";
import EquationsDoc from "./equationDoc";

export const EQUATIONS_PLUGIN: CorePlugin = {
  id: "equations",
  name: "Equations",
  description:
    "Compute inside a note: `= 5-3` renders 2, and an operand can be a property from any note.",
  settingKey: "plugins.equations_enabled",
  defaultEnabled: true,
  doc: EquationsDoc,
  requires: ["property-refs"],
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.equations_enabled": boolean;
  }
}
