import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../styles/theme", () => ({
  applyTheme: (mode: string) => (mode === "system" ? "light" : mode),
}));

import { setSetting } from "../api/ipc";
import { CORE_PLUGINS } from "./corePlugins";
import { SETTINGS_DEFAULTS } from "./defaults";
import { resetSettings } from "./resetSettings";
import { createSettingsState } from "./settingsState";

const written = setSetting as unknown as ReturnType<typeof vi.fn>;

const build = () =>
  createRoot(() => createSettingsState({ vaultId: () => "v1" }));

beforeEach(() => {
  written.mockReset();
  written.mockImplementation(() => Promise.resolve());
});

describe("resetSettings", () => {
  it("puts every setting back to its default", () => {
    const s = build();
    s.setTheme("dark");
    s.setRawDefaultValue(true);
    s.setRawOverride(false);
    s.setMinimapEnabledValue(true);
    s.setColorizeSourceValue(true);
    s.setLiveTabLimitValue(9);
    s.setRewriteBrokenLinksValue(false);
    s.setTypedPropsValue(true);
    s.setDateDefaultValue("DD/MM/YYYY");
    s.setCurrencyDefaultValue("eur");
    s.setTagsKeyAsTagsValue(false);
    s.setShortcutOverridesValue({ "file.new": "Mod-J" });

    resetSettings(s);

    expect(s.themeMode()).toBe(SETTINGS_DEFAULTS.themeMode);
    expect(s.rawDefault()).toBe(SETTINGS_DEFAULTS.rawSourceDefault);
    expect(s.rawOverride()).toBe(null);
    expect(s.minimapEnabled()).toBe(SETTINGS_DEFAULTS.minimapEnabled);
    expect(s.colorizeSource()).toBe(SETTINGS_DEFAULTS.colorizeSource);
    expect(s.liveTabLimit()).toBe(SETTINGS_DEFAULTS.liveTabLimit);
    expect(s.rewriteBrokenLinks()).toBe(SETTINGS_DEFAULTS.rewriteBrokenLinks);
    expect(s.typedProps()).toBe(SETTINGS_DEFAULTS.typedProps);
    expect(s.dateDefault()).toBe(SETTINGS_DEFAULTS.dateDefault);
    expect(s.currencyDefault()).toBe(SETTINGS_DEFAULTS.currencyDefault);
    expect(s.tagsKeyAsTags()).toBe(SETTINGS_DEFAULTS.tagsKeyAsTags);
    expect(s.shortcutOverrides()).toEqual({});
  });

  it("returns each core plugin to its own default, not to on", () => {
    const s = build();
    s.setCorePlugin("terminal", "plugins.terminal_enabled", true);
    s.setCorePlugin("dataview", "plugins.dataview_enabled", false);

    resetSettings(s);

    for (const plugin of CORE_PLUGINS) {
      expect(s.corePlugins()[plugin.id]).toBe(plugin.defaultEnabled);
    }
  });

  it("persists the defaults it restores", () => {
    const s = build();
    s.setMinimapEnabledValue(true);
    written.mockClear();

    resetSettings(s);

    expect(written).toHaveBeenCalledWith("v1", "editor.minimap_enabled", false);
    expect(written).toHaveBeenCalledWith("v1", "shortcuts.overrides", {});
  });

  it("expands a collapsed right sidebar and leaves an expanded one alone", () => {
    const s = build();
    s.toggleRightSidebar();
    expect(s.rightSidebarCollapsed()).toBe(true);

    resetSettings(s);
    expect(s.rightSidebarCollapsed()).toBe(false);

    resetSettings(s);
    expect(s.rightSidebarCollapsed()).toBe(false);
  });
});
