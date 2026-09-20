import { registeredBlockSettings } from "./blockSettings";
import { registeredCorePlugins } from "./corePlugins";
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

  for (const setting of registeredBlockSettings()) {
    settings.setValue(setting.key, setting.fallback);
  }

  for (const plugin of registeredCorePlugins()) {
    settings.setCorePlugin(plugin.id, plugin.settingKey, plugin.defaultEnabled);
  }

  const collapsed = settings.rightSidebarCollapsed();
  if (collapsed !== SETTINGS_DEFAULTS.rightSidebarCollapsed) {
    settings.toggleRightSidebar();
  }
  settings.setRightSidebarPanelValue(SETTINGS_DEFAULTS.rightSidebarPanel);
  settings.setLeftSidebarModeValue(SETTINGS_DEFAULTS.leftSidebarMode);
  settings.setShortcutOverridesValue({});
}
