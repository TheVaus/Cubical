import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../styles/theme", () => ({
  applyTheme: (mode: string) => (mode === "system" ? "light" : mode),
}));

import { getSetting, setSetting } from "../api/ipc";
import { createSettingsState } from "./settingsState";
import { VAULT_PATH_SEGMENT } from "../statusbar/segments";

const stored = getSetting as unknown as ReturnType<typeof vi.fn>;
const written = setSetting as unknown as ReturnType<typeof vi.fn>;

const build = (vaultId: string | null = "v1") =>
  createRoot(() => createSettingsState({ vaultId: () => vaultId }));

beforeEach(() => {
  stored.mockReset();
  written.mockReset();
  written.mockImplementation(() => Promise.resolve());
});

describe("raw source", () => {
  it("resolves the override above the default", () => {
    const s = build();
    s.setRawDefaultValue(true);
    expect(s.effectiveRaw()).toBe(true);

    s.setRawOverride(false);
    expect(s.effectiveRaw()).toBe(false);
  });

  it("clears a stale override when the default changes", () => {
    const s = build();
    s.setRawOverride(true);
    expect(s.effectiveRaw()).toBe(true);

    s.setRawDefaultValue(false);
    expect(s.rawOverride()).toBe(null);
    expect(s.effectiveRaw()).toBe(false);
  });
});

describe("persistence", () => {
  it("writes the key the setting is stored under", () => {
    const s = build();
    s.setMinimapEnabledValue(true);
    expect(written).toHaveBeenCalledWith("v1", "editor.minimap_enabled", true);
  });

  it("clamps the live tab limit before storing it", () => {
    const s = build();
    s.setLiveTabLimitValue(0);
    expect(s.liveTabLimit()).toBeGreaterThanOrEqual(1);
    expect(written).toHaveBeenCalledWith(
      "v1",
      "editor.live_tab_limit",
      s.liveTabLimit(),
    );
  });

  it("does not write when no vault is open", () => {
    const s = build(null);
    s.setMinimapEnabledValue(true);
    expect(s.minimapEnabled()).toBe(true);
    expect(written).not.toHaveBeenCalled();
  });

  it("refuses an unknown right-sidebar panel", () => {
    const s = build();
    s.setRightSidebarPanelValue("nonsense");
    expect(s.rightSidebarPanel()).toBe("backlinks");
    expect(written).not.toHaveBeenCalled();
  });

  it("persists the left-sidebar mode", () => {
    const s = build();
    s.setLeftSidebarModeValue("tags");
    expect(s.leftSidebarMode()).toBe("tags");
    expect(written).toHaveBeenCalledWith("v1", "ui.left_sidebar_mode", "tags");
  });

  it("refuses an unknown left-sidebar mode", () => {
    const s = build();
    s.setLeftSidebarModeValue("nonsense");
    expect(s.leftSidebarMode()).toBe("files");
    expect(written).not.toHaveBeenCalled();
  });
});

describe("statusbar", () => {
  it("toggles the bar through the enabled key", () => {
    const s = build();
    const before = s.statusbarEnabled();
    s.toggleStatusbar();
    expect(s.statusbarEnabled()).toBe(!before);
  });

  it("leaves plugin state alone when no vault is open", () => {
    const s = build(null);
    s.setCorePlugin("dataview", "plugins.dataview_enabled", true);
    expect(s.corePlugins()).toEqual({});
  });
});

describe("hydrate", () => {
  it("falls back to the default when a key is absent", async () => {
    stored.mockResolvedValue(null);
    const s = build();
    await s.hydrate("v1");
    expect(s.dateDefault()).toBe("YYYY-MM-DD");
    expect(s.currencyDefault()).toBe("usd");
    expect(s.tagsKeyAsTags()).toBe(true);
  });

  it("survives a rejected read and keeps the default", async () => {
    stored.mockRejectedValue(new Error("index unavailable"));
    const s = build();
    await s.hydrate("v1");
    expect(s.themeMode()).toBe("system");
    expect(s.minimapEnabled()).toBe(false);
  });

  it("applies stored values", async () => {
    stored.mockImplementation((_v: string, key: string) =>
      Promise.resolve(key === "properties.default_currency" ? "eur" : null),
    );
    const s = build();
    await s.hydrate("v1");
    expect(s.currencyDefault()).toBe("eur");
  });
});

describe("resetForVaultSwitch", () => {
  it("drops per-vault view state without persisting anything", () => {
    const s = build();
    s.setRawOverride(true);
    s.toggleRightSidebar();
    s.setRightSidebarPanelValue("integrity");
    s.setLeftSidebarModeValue("tags");
    s.setShortcutOverridesValue({ "file.new": "Mod-J" });
    written.mockClear();

    s.resetForVaultSwitch();

    expect(s.rawOverride()).toBe(null);
    expect(s.rightSidebarCollapsed()).toBe(false);
    expect(s.rightSidebarPanel()).toBe("backlinks");
    expect(s.leftSidebarMode()).toBe("files");
    expect(s.shortcutOverrides()).toEqual({});
    expect(written).not.toHaveBeenCalled();
  });

  it("drops the outgoing vault's plugin and statusbar toggles", () => {
    const s = build();
    s.setCorePlugin("dataview", "plugins.dataview_enabled", false);
    s.setStatusbarSetting(VAULT_PATH_SEGMENT.settingKey, false);
    s.toggleStatusbar();
    expect(s.corePlugins()).toEqual({ dataview: false });
    expect(s.segVisible(VAULT_PATH_SEGMENT)).toBe(false);
    expect(s.statusbarEnabled()).toBe(false);

    s.resetForVaultSwitch();

    expect(s.corePlugins()).toEqual({});
    expect(s.statusbarConfig()).toEqual({});
    expect(s.segVisible(VAULT_PATH_SEGMENT)).toBe(true);
    expect(s.statusbarEnabled()).toBe(true);
  });
});
