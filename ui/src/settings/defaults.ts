import { DEFAULT_LIVE_TAB_LIMIT } from "../tabs/lru";
import type { ThemeMode } from "../styles/theme";

export const SETTINGS_DEFAULTS = {
  themeMode: "system" as ThemeMode,
  rawSourceDefault: false,
  minimapEnabled: false,
  colorizeSource: false,
  liveTabLimit: DEFAULT_LIVE_TAB_LIMIT,
  rewriteBrokenLinks: true,
  rightSidebarCollapsed: false,
};
