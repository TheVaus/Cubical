import type { CorePlugin } from "../settings/corePlugins";
import MathDoc from "./mathDoc";

export const MATH_PLUGIN: CorePlugin = {
  id: "math",
  name: "Math",
  description:
    "Typeset LaTeX with KaTeX — ```math blocks and $$…$$ display math render as you write.",
  settingKey: "plugins.math_enabled",
  defaultEnabled: true,
  doc: MathDoc,
};

declare module "../api/ipc" {
  interface SettingRegistry {
    "plugins.math_enabled": boolean;
  }
}
