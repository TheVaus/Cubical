import { DEFAULT_LIVE_TAB_LIMIT } from "../tabs/lru";
import type { ThemeMode } from "../styles/theme";
import type { RightSidebarPanel } from "./settingsState";

export const SETTINGS_DEFAULTS = {
  themeMode: "system" as ThemeMode,
  rawSourceDefault: false,
  minimapEnabled: false,
  colorizeSource: false,
  liveTabLimit: DEFAULT_LIVE_TAB_LIMIT,
  rewriteBrokenLinks: true,
  typedProps: false,
  dateDefault: "YYYY-MM-DD",
  currencyDefault: "usd",
  tagsKeyAsTags: true,
  rightSidebarCollapsed: false,
  rightSidebarPanel: "backlinks" as RightSidebarPanel,
};
