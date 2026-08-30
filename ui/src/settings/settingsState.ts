import { createMemo, createSignal, type Accessor } from "solid-js";

import { getSetting } from "../api/ipc";
import { persistSetting, seedSetting } from "../core/settings";
import { resolveBindings, type KeyBinding } from "../core/commands";
import { clampLimit } from "../tabs/lru";
import { resolveRawState } from "../editor/rawSource";
import {
  applyTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "../styles/theme";
import { CORE_PLUGINS, type BooleanSettingKey } from "./corePlugins";
import { SETTINGS_DEFAULTS } from "./defaults";
import {
  STATUSBAR_DEFAULT,
  STATUSBAR_ENABLED_KEY,
  STATUSBAR_SEGMENTS,
  segmentVisible,
  type StatusbarSegment,
} from "../statusbar/segments";

export type RightSidebarPanel = "backlinks" | "unlinked_mentions" | "integrity";
export type LeftSidebarMode = "files" | "tags";

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

  typedProps: Accessor<boolean>;
  setTypedPropsValue: (value: boolean) => void;
  dateDefault: Accessor<string>;
  setDateDefaultValue: (value: string) => void;
  currencyDefault: Accessor<string>;
  setCurrencyDefaultValue: (value: string) => void;
  tagsKeyAsTags: Accessor<boolean>;
  setTagsKeyAsTagsValue: (value: boolean) => void;

  corePlugins: Accessor<Record<string, boolean>>;
  setCorePlugin: (
    id: string,
    settingKey: BooleanSettingKey,
    value: boolean,
  ) => void;

  statusbarConfig: Accessor<Record<string, boolean>>;
  statusbarEnabled: Accessor<boolean>;
  segVisible: (segment: StatusbarSegment) => boolean;
  setStatusbarSetting: (key: BooleanSettingKey, value: boolean) => void;
  toggleStatusbar: () => void;

  rightSidebarCollapsed: Accessor<boolean>;
  toggleRightSidebar: () => void;
  rightSidebarPanel: Accessor<RightSidebarPanel>;
  setRightSidebarPanelValue: (id: string) => void;
  leftSidebarMode: Accessor<LeftSidebarMode>;
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
  const [typedProps, setTypedProps] = createSignal(SETTINGS_DEFAULTS.typedProps);
  const [dateDefault, setDateDefault] = createSignal(
    SETTINGS_DEFAULTS.dateDefault,
  );
  const [currencyDefault, setCurrencyDefault] = createSignal(
    SETTINGS_DEFAULTS.currencyDefault,
  );
  const [tagsKeyAsTags, setTagsKeyAsTags] = createSignal(
    SETTINGS_DEFAULTS.tagsKeyAsTags,
  );
  const [corePlugins, setCorePlugins] = createSignal<Record<string, boolean>>(
    {},
  );
  const [statusbarConfig, setStatusbarConfig] = createSignal<
    Record<string, boolean>
  >({});
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(
    SETTINGS_DEFAULTS.rightSidebarCollapsed,
  );
  const [rightSidebarPanel, setRightSidebarPanel] =
    createSignal<RightSidebarPanel>(SETTINGS_DEFAULTS.rightSidebarPanel);
  const [leftSidebarMode, setLeftSidebarMode] = createSignal<LeftSidebarMode>(
    SETTINGS_DEFAULTS.leftSidebarMode,
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
  const statusbarEnabled = () =>
    statusbarConfig()[STATUSBAR_ENABLED_KEY] ?? STATUSBAR_DEFAULT;
  const segVisible = (seg: StatusbarSegment) =>
    segmentVisible(statusbarConfig(), seg);

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

  const setTypedPropsValue = (value: boolean) => {
    setTypedProps(value);
    persistSetting(vid(), "properties.typed_enabled", value);
  };

  const setDateDefaultValue = (value: string) => {
    setDateDefault(value);
    persistSetting(vid(), "properties.date_format_default", value);
  };

  const setCurrencyDefaultValue = (value: string) => {
    setCurrencyDefault(value);
    persistSetting(vid(), "properties.default_currency", value);
  };

  const setTagsKeyAsTagsValue = (value: boolean) => {
    setTagsKeyAsTags(value);
    persistSetting(vid(), "properties.tags_key_as_tags", value);
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

  const setStatusbarSetting = (key: BooleanSettingKey, value: boolean) => {
    const v = vid();
    if (!v) return;
    setStatusbarConfig((prev) => ({ ...prev, [key]: value }));
    persistSetting(v, key, value);
  };

  const toggleStatusbar = () =>
    setStatusbarSetting(STATUSBAR_ENABLED_KEY, !statusbarEnabled());

  const toggleRightSidebar = () => {
    const next = !rightSidebarCollapsed();
    setRightSidebarCollapsed(next);
    persistSetting(vid(), "ui.right_sidebar_collapsed", next);
  };

  const setRightSidebarPanelValue = (id: string) => {
    if (id !== "backlinks" && id !== "unlinked_mentions" && id !== "integrity")
      return;
    setRightSidebarPanel(id);
    persistSetting(vid(), "ui.right_sidebar_panel", id);
  };

  const setLeftSidebarModeValue = (id: string) => {
    if (id !== "files" && id !== "tags") return;
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
    setRightSidebarPanel("backlinks");
    setLeftSidebarMode("files");
    setShortcutOverrides({});
    setCorePlugins({});
    setStatusbarConfig({});
  };

  const hydrate = async (vaultId: string) => {
    try {
      const stored = await getSetting(vaultId, "appearance.theme_mode");
      if (stored !== null) {
        setThemeMode(stored);
        setResolvedTheme(applyTheme(stored));
      }
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
    await seedSetting(
      vaultId,
      "properties.typed_enabled",
      SETTINGS_DEFAULTS.typedProps,
      setTypedProps,
    );
    await seedSetting(
      vaultId,
      "properties.date_format_default",
      SETTINGS_DEFAULTS.dateDefault,
      setDateDefault,
    );
    await seedSetting(
      vaultId,
      "properties.default_currency",
      SETTINGS_DEFAULTS.currencyDefault,
      setCurrencyDefault,
    );
    await seedSetting(
      vaultId,
      "properties.tags_key_as_tags",
      SETTINGS_DEFAULTS.tagsKeyAsTags,
      setTagsKeyAsTags,
    );

    const enabled: Record<string, boolean> = {};
    for (const p of CORE_PLUGINS) {
      try {
        const stored = await getSetting(vaultId, p.settingKey);
        enabled[p.id] = stored ?? p.defaultEnabled;
      } catch (e) {
        console.error(`loading ${p.settingKey} failed`, e);
        enabled[p.id] = p.defaultEnabled;
      }
    }
    setCorePlugins(enabled);

    const cfg: Record<string, boolean> = {};
    const keys: BooleanSettingKey[] = [
      STATUSBAR_ENABLED_KEY,
      ...STATUSBAR_SEGMENTS.map((s) => s.settingKey),
    ];
    for (const k of keys) {
      try {
        cfg[k] = (await getSetting(vaultId, k)) ?? STATUSBAR_DEFAULT;
      } catch (e) {
        console.error(`loading ${k} failed`, e);
        cfg[k] = STATUSBAR_DEFAULT;
      }
    }
    setStatusbarConfig(cfg);

    await seedSetting(
      vaultId,
      "ui.right_sidebar_collapsed",
      SETTINGS_DEFAULTS.rightSidebarCollapsed,
      setRightSidebarCollapsed,
    );
    await seedSetting(
      vaultId,
      "ui.right_sidebar_panel",
      SETTINGS_DEFAULTS.rightSidebarPanel,
      setRightSidebarPanel,
    );
    await seedSetting(
      vaultId,
      "ui.left_sidebar_mode",
      SETTINGS_DEFAULTS.leftSidebarMode,
      setLeftSidebarMode,
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
    typedProps,
    setTypedPropsValue,
    dateDefault,
    setDateDefaultValue,
    currencyDefault,
    setCurrencyDefaultValue,
    tagsKeyAsTags,
    setTagsKeyAsTagsValue,
    corePlugins,
    setCorePlugin,
    statusbarConfig,
    statusbarEnabled,
    segVisible,
    setStatusbarSetting,
    toggleStatusbar,
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
