import { createMemo, createSignal, type Accessor } from "solid-js";

import { getSetting, type Setting, type SettingValue } from "../api/ipc";
import { persistSetting, seedSetting } from "../core/settings";
import { resolveBindings, type KeyBinding } from "../core/commands";
import { clampLimit } from "../tabs/lru";
import { resolveRawState } from "./rawSource";
import {
  applyTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "../styles/theme";
import {
  fallbackFor,
  registeredBlockSettings,
  type SettingKey,
} from "./blockSettings";
import { registeredCorePlugins, type BooleanSettingKey } from "./corePlugins";
import { SETTINGS_DEFAULTS } from "./defaults";
import {
  defaultLeftSidebarMode,
  defaultSidebarPanel,
  isLeftSidebarMode,
  isSidebarPanel,
} from "./sidebarPanels";

export interface SettingsStateDeps {
  vaultId: Accessor<string | null>;
}

export interface SettingsState {
  themeMode: Accessor<ThemeMode>;
  resolvedTheme: Accessor<ResolvedTheme>;
  setTheme: (mode: ThemeMode) => void;
  reapplySystemTheme: () => void;

  rawDefault: Accessor<boolean>;
  rawOverride: Accessor<boolean | null>;
  effectiveRaw: Accessor<boolean>;
  setRawOverride: (value: boolean | null) => void;
  setRawDefaultValue: (value: boolean) => void;

  minimapEnabled: Accessor<boolean>;
  setMinimapEnabledValue: (value: boolean) => void;
  colorizeSource: Accessor<boolean>;
  setColorizeSourceValue: (value: boolean) => void;
  liveTabLimit: Accessor<number>;
  setLiveTabLimitValue: (value: number) => void;

  rewriteBrokenLinks: Accessor<boolean>;
  setRewriteBrokenLinksValue: (value: boolean) => void;

  corePlugins: Accessor<Record<string, boolean>>;
  setCorePlugin: (
    id: string,
    settingKey: BooleanSettingKey,
    value: boolean,
  ) => void;

  value: <K extends SettingKey>(key: K) => SettingValue<K>;
  setValue: <K extends SettingKey>(key: K, value: SettingValue<K>) => void;
  toggle: (key: BooleanSettingKey) => void;

  rightSidebarCollapsed: Accessor<boolean>;
  toggleRightSidebar: () => void;
  rightSidebarPanel: Accessor<string>;
  setRightSidebarPanelValue: (id: string) => void;
  leftSidebarMode: Accessor<string>;
  setLeftSidebarModeValue: (id: string) => void;

  shortcutOverrides: Accessor<Record<string, string>>;
  setShortcutOverridesValue: (next: Record<string, string>) => void;
  effectiveBindings: Accessor<KeyBinding[]>;

  hydrate: (vaultId: string) => Promise<void>;
  resetForVaultSwitch: () => void;
}

export function createSettingsState(deps: SettingsStateDeps): SettingsState {
  const vid = () => deps.vaultId();

  const [themeMode, setThemeMode] = createSignal<ThemeMode>(SETTINGS_DEFAULTS.themeMode);
  const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>(
    applyTheme(SETTINGS_DEFAULTS.themeMode),
  );

  const [rawDefault, setRawDefault] = createSignal(
    SETTINGS_DEFAULTS.rawSourceDefault,
  );
  const [rawOverride, setRawOverride] = createSignal<boolean | null>(null);
  const [minimapEnabled, setMinimapEnabled] = createSignal(
    SETTINGS_DEFAULTS.minimapEnabled,
  );
  const [colorizeSource, setColorizeSource] = createSignal(
    SETTINGS_DEFAULTS.colorizeSource,
  );
  const [liveTabLimit, setLiveTabLimit] = createSignal(
    SETTINGS_DEFAULTS.liveTabLimit,
  );
  const [rewriteBrokenLinks, setRewriteBrokenLinks] = createSignal(
    SETTINGS_DEFAULTS.rewriteBrokenLinks,
  );
  const [corePlugins, setCorePlugins] = createSignal<Record<string, boolean>>(
    {},
  );
  const [blockValues, setBlockValues] = createSignal<
    Record<string, Setting["value"]>
  >({});
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(
    SETTINGS_DEFAULTS.rightSidebarCollapsed,
  );
  const [rightSidebarPanel, setRightSidebarPanel] = createSignal<string>(
    defaultSidebarPanel(),
  );
  const [leftSidebarMode, setLeftSidebarMode] = createSignal<string>(
    defaultLeftSidebarMode(),
  );
  const [shortcutOverrides, setShortcutOverrides] = createSignal<
    Record<string, string>
  >({});

  const effectiveRaw = createMemo(() =>
    resolveRawState(rawOverride(), rawDefault()),
  );
  const effectiveBindings = createMemo(() =>
    resolveBindings(shortcutOverrides()),
  );
  const value = <K extends SettingKey>(key: K): SettingValue<K> =>
    (blockValues()[key] ?? fallbackFor(key)) as SettingValue<K>;

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setResolvedTheme(applyTheme(mode));
    persistSetting(vid(), "appearance.theme_mode", mode);
  };

  const reapplySystemTheme = () => {
    if (themeMode() === "system") setResolvedTheme(applyTheme("system"));
  };

  const setRawDefaultValue = (value: boolean) => {
    setRawDefault(value);
    setRawOverride(null);
    persistSetting(vid(), "editor.raw_source_default", value);
  };

  const setMinimapEnabledValue = (value: boolean) => {
    setMinimapEnabled(value);
    persistSetting(vid(), "editor.minimap_enabled", value);
  };

  const setColorizeSourceValue = (value: boolean) => {
    setColorizeSource(value);
    persistSetting(vid(), "editor.colorize_raw_source", value);
  };

  const setLiveTabLimitValue = (raw: number) => {
    const value = clampLimit(raw);
    setLiveTabLimit(value);
    persistSetting(vid(), "editor.live_tab_limit", value);
  };

  const setRewriteBrokenLinksValue = (value: boolean) => {
    setRewriteBrokenLinks(value);
    persistSetting(vid(), "wikilinks.rewrite_broken_links_on_rename", value);
  };

  const setCorePlugin = (
    id: string,
    settingKey: BooleanSettingKey,
    value: boolean,
  ) => {
    const v = vid();
    if (!v) return;
    setCorePlugins((prev) => ({ ...prev, [id]: value }));
    persistSetting(v, settingKey, value);
  };

  const setValue = <K extends SettingKey>(key: K, next: SettingValue<K>) => {
    setBlockValues((prev) => ({ ...prev, [key]: next }));
    persistSetting(vid(), key, next);
  };

  const toggle = (key: BooleanSettingKey) => setValue(key, !value(key));

  const toggleRightSidebar = () => {
    const next = !rightSidebarCollapsed();
    setRightSidebarCollapsed(next);
    persistSetting(vid(), "ui.right_sidebar_collapsed", next);
  };

  const setRightSidebarPanelValue = (id: string) => {
    if (!isSidebarPanel(id)) return;
    setRightSidebarPanel(id);
    persistSetting(vid(), "ui.right_sidebar_panel", id);
  };

  const setLeftSidebarModeValue = (id: string) => {
    if (!isLeftSidebarMode(id)) return;
    setLeftSidebarMode(id);
    persistSetting(vid(), "ui.left_sidebar_mode", id);
  };

  const setShortcutOverridesValue = (next: Record<string, string>) => {
    setShortcutOverrides(next);
    persistSetting(vid(), "shortcuts.overrides", next);
  };

  const resetForVaultSwitch = () => {
    setRawOverride(null);
    setRightSidebarCollapsed(false);
    setRightSidebarPanel(defaultSidebarPanel());
    setLeftSidebarMode(defaultLeftSidebarMode());
    setShortcutOverrides({});
    setCorePlugins({});
    setBlockValues({});
  };

  const hydrate = async (vaultId: string) => {
    try {
      const mode =
        (await getSetting(vaultId, "appearance.theme_mode")) ??
        SETTINGS_DEFAULTS.themeMode;
      setThemeMode(mode);
      setResolvedTheme(applyTheme(mode));
    } catch (e) {
      console.error("loading theme_mode failed", e);
    }

    await seedSetting(
      vaultId,
      "editor.raw_source_default",
      SETTINGS_DEFAULTS.rawSourceDefault,
      setRawDefault,
    );
    await seedSetting(
      vaultId,
      "editor.minimap_enabled",
      SETTINGS_DEFAULTS.minimapEnabled,
      setMinimapEnabled,
    );
    await seedSetting(
      vaultId,
      "editor.live_tab_limit",
      SETTINGS_DEFAULTS.liveTabLimit,
      (v) => setLiveTabLimit(clampLimit(v)),
    );
    await seedSetting(
      vaultId,
      "editor.colorize_raw_source",
      SETTINGS_DEFAULTS.colorizeSource,
      setColorizeSource,
    );
    await seedSetting(
      vaultId,
      "wikilinks.rewrite_broken_links_on_rename",
      SETTINGS_DEFAULTS.rewriteBrokenLinks,
      setRewriteBrokenLinks,
    );
    const enabled: Record<string, boolean> = {};
    for (const p of registeredCorePlugins()) {
      try {
        const stored = await getSetting(vaultId, p.settingKey);
        enabled[p.id] = stored ?? p.defaultEnabled;
      } catch (e) {
        console.error(`loading ${p.settingKey} failed`, e);
        enabled[p.id] = p.defaultEnabled;
      }
    }
    setCorePlugins(enabled);

    const stored: Record<string, Setting["value"]> = {};
    for (const setting of registeredBlockSettings()) {
      try {
        stored[setting.key] =
          (await getSetting(vaultId, setting.key)) ?? setting.fallback;
      } catch (e) {
        console.error(`loading ${setting.key} failed`, e);
        stored[setting.key] = setting.fallback;
      }
    }
    setBlockValues(stored);

    await seedSetting(
      vaultId,
      "ui.right_sidebar_collapsed",
      SETTINGS_DEFAULTS.rightSidebarCollapsed,
      setRightSidebarCollapsed,
    );
    await seedSetting(
      vaultId,
      "ui.right_sidebar_panel",
      defaultSidebarPanel(),
      (id) => setRightSidebarPanel(isSidebarPanel(id) ? id : defaultSidebarPanel()),
    );
    await seedSetting(
      vaultId,
      "ui.left_sidebar_mode",
      defaultLeftSidebarMode(),
      (id) =>
        setLeftSidebarMode(isLeftSidebarMode(id) ? id : defaultLeftSidebarMode()),
    );
    await seedSetting(vaultId, "shortcuts.overrides", {}, setShortcutOverrides);
  };

  return {
    themeMode,
    resolvedTheme,
    setTheme,
    reapplySystemTheme,
    rawDefault,
    rawOverride,
    effectiveRaw,
    setRawOverride,
    setRawDefaultValue,
    minimapEnabled,
    setMinimapEnabledValue,
    colorizeSource,
    setColorizeSourceValue,
    liveTabLimit,
    setLiveTabLimitValue,
    rewriteBrokenLinks,
    setRewriteBrokenLinksValue,
    corePlugins,
    setCorePlugin,
    value,
    setValue,
    toggle,
    rightSidebarCollapsed,
    toggleRightSidebar,
    rightSidebarPanel,
    leftSidebarMode,
    setLeftSidebarModeValue,
    setRightSidebarPanelValue,
    shortcutOverrides,
    setShortcutOverridesValue,
    effectiveBindings,
    hydrate,
    resetForVaultSwitch,
  };
}
