// @vitest-environment jsdom
import { createComputed, createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../styles/theme", () => ({
  applyTheme: (mode: string) => (mode === "system" ? "light" : mode),
}));

import { setSetting } from "../api/ipc";
import { registerBlocks } from "../shell/registerBlocks";
import { registeredStatusbarSegments } from "../statusbar/statusbarSettings";
import { registeredBlockSettings } from "./blockSettings";
import { registeredCorePlugins } from "./corePlugins";
import { SETTINGS_DEFAULTS } from "./defaults";
import { resetSettings } from "./resetSettings";
import { createSettingsState } from "./settingsState";

registerBlocks();

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
    s.setValue("properties.typed_enabled", true);
    s.setValue("properties.date_format_default", "DD/MM/YYYY");
    s.setValue("properties.default_currency", "eur");
    s.setValue("properties.tags_key_as_tags", false);
    s.setShortcutOverridesValue({ "file.new": "Mod-J" });

    resetSettings(s);

    expect(s.themeMode()).toBe(SETTINGS_DEFAULTS.themeMode);
    expect(s.rawDefault()).toBe(SETTINGS_DEFAULTS.rawSourceDefault);
    expect(s.rawOverride()).toBe(null);
    expect(s.minimapEnabled()).toBe(SETTINGS_DEFAULTS.minimapEnabled);
    expect(s.colorizeSource()).toBe(SETTINGS_DEFAULTS.colorizeSource);
    expect(s.liveTabLimit()).toBe(SETTINGS_DEFAULTS.liveTabLimit);
    expect(s.rewriteBrokenLinks()).toBe(SETTINGS_DEFAULTS.rewriteBrokenLinks);
    for (const setting of registeredBlockSettings()) {
      expect(s.value(setting.key)).toBe(setting.fallback);
    }
    expect(s.shortcutOverrides()).toEqual({});
  });

  it("returns each core plugin to its own default, not to on", () => {
    const s = build();
    s.setCorePlugin("terminal", "plugins.terminal_enabled", true);
    s.setCorePlugin("dataview", "plugins.dataview_enabled", false);

    resetSettings(s);

    expect(s.corePlugins()["terminal"]).toBe(false);
    for (const plugin of registeredCorePlugins()) {
      expect(s.corePlugins()[plugin.id]).toBe(plugin.defaultEnabled);
    }
  });

  it("shows every registered statusbar segment again", () => {
    const s = build();
    const segments = registeredStatusbarSegments();
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) s.setValue(seg.settingKey, false);

    resetSettings(s);

    for (const seg of segments) {
      expect(s.value(seg.settingKey)).toBe(seg.defaultVisible);
    }
  });

  it("restores a block's own setting without naming it", () => {
    const s = build();
    expect(registeredBlockSettings().length).toBeGreaterThan(0);
    s.setValue("properties.default_currency", "eur");

    resetSettings(s);

    expect(s.value("properties.default_currency")).toBe("usd");
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

  it("notifies a reader of every block value once, not once per key", () => {
    const s = build();
    for (const seg of registeredStatusbarSegments()) s.setValue(seg.settingKey, false);
    let runs = 0;
    createRoot(() =>
      createComputed(() => {
        for (const setting of registeredBlockSettings()) s.value(setting.key);
        runs += 1;
      }),
    );
    runs = 0;

    resetSettings(s);

    expect(runs).toBe(1);
  });
});
