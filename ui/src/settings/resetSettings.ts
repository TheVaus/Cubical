import {
  STATUSBAR_DEFAULT,
  STATUSBAR_ENABLED_KEY,
  STATUSBAR_SEGMENTS,
} from "../statusbar/segments";
import { CORE_PLUGINS } from "./corePlugins";
import { SETTINGS_DEFAULTS } from "./defaults";
import type { SettingsState } from "./settingsState";

export function resetSettings(settings: SettingsState): void {
  settings.setTheme(SETTINGS_DEFAULTS.themeMode);
  settings.setRawOverride(null);
  settings.setRawDefaultValue(SETTINGS_DEFAULTS.rawSourceDefault);
  settings.setMinimapEnabledValue(SETTINGS_DEFAULTS.minimapEnabled);
  settings.setColorizeSourceValue(SETTINGS_DEFAULTS.colorizeSource);
  settings.setLiveTabLimitValue(SETTINGS_DEFAULTS.liveTabLimit);
  settings.setRewriteBrokenLinksValue(SETTINGS_DEFAULTS.rewriteBrokenLinks);
  settings.setTypedPropsValue(SETTINGS_DEFAULTS.typedProps);
  settings.setDateDefaultValue(SETTINGS_DEFAULTS.dateDefault);
  settings.setCurrencyDefaultValue(SETTINGS_DEFAULTS.currencyDefault);
  settings.setTagsKeyAsTagsValue(SETTINGS_DEFAULTS.tagsKeyAsTags);

  for (const plugin of CORE_PLUGINS) {
    settings.setCorePlugin(plugin.id, plugin.settingKey, plugin.defaultEnabled);
  }

  settings.setStatusbarSetting(STATUSBAR_ENABLED_KEY, STATUSBAR_DEFAULT);
  for (const segment of STATUSBAR_SEGMENTS) {
    settings.setStatusbarSetting(segment.settingKey, STATUSBAR_DEFAULT);
  }

  const collapsed = settings.rightSidebarCollapsed();
  if (collapsed !== SETTINGS_DEFAULTS.rightSidebarCollapsed) {
    settings.toggleRightSidebar();
  }
  settings.setRightSidebarPanelValue(SETTINGS_DEFAULTS.rightSidebarPanel);
  settings.setLeftSidebarModeValue(SETTINGS_DEFAULTS.leftSidebarMode);
  settings.setShortcutOverridesValue({});
}
