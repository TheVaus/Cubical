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
import { registerCommands } from "../core/commandRegistry";
import { GRAPH_COMMAND, GRAPH_PLUGIN } from "../graph/registration";
import { propertiesBlockSettings } from "../properties/formats";
import { STATUSBAR_SEGMENTS, VAULT_PATH_SEGMENT } from "../statusbar/segments";
import {
  registerStatusbarSegments,
  statusbarBlockSettings,
} from "../statusbar/statusbarSettings";
import { registerBlockSettings } from "./blockSettings";
import { registerCorePlugins } from "./corePlugins";
import {
  registerLeftSidebarModes,
  registerSidebarPanels,
} from "./sidebarPanels";
import { createSettingsState } from "./settingsState";

registerSidebarPanels([
  { id: "first-panel", label: "First", order: 10, panel: () => null },
  { id: "second-panel", label: "Second", order: 20, panel: () => null },
]);
registerLeftSidebarModes(["first-mode", "second-mode"]);
registerCorePlugins([GRAPH_PLUGIN]);
registerCommands([GRAPH_COMMAND]);
registerStatusbarSegments(STATUSBAR_SEGMENTS);
registerBlockSettings([
  ...statusbarBlockSettings(),
  ...propertiesBlockSettings(),
]);

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
    expect(s.rightSidebarPanel()).toBe("first-panel");
    expect(written).not.toHaveBeenCalled();
  });

  it("persists the left-sidebar mode", () => {
    const s = build();
    s.setLeftSidebarModeValue("second-mode");
    expect(s.leftSidebarMode()).toBe("second-mode");
    expect(written).toHaveBeenCalledWith(
      "v1",
      "ui.left_sidebar_mode",
      "second-mode",
    );
  });

  it("refuses an unknown left-sidebar mode", () => {
    const s = build();
    s.setLeftSidebarModeValue("nonsense");
    expect(s.leftSidebarMode()).toBe("first-mode");
    expect(written).not.toHaveBeenCalled();
  });
});

describe("block settings", () => {
  it("toggles a registered boolean key without naming its block", () => {
    const s = build();
    const before = s.value("statusbar.enabled");
    s.toggle("statusbar.enabled");
    expect(s.value("statusbar.enabled")).toBe(!before);
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
    expect(s.value("properties.date_format_default")).toBe("YYYY-MM-DD");
    expect(s.value("properties.default_currency")).toBe("usd");
    expect(s.value("properties.tags_key_as_tags")).toBe(true);
  });

  it("does not carry the previous vault's theme into one that stores none", async () => {
    stored.mockImplementation((v: string, key: string) =>
      Promise.resolve(v === "v1" && key === "appearance.theme_mode" ? "dark" : null),
    );
    const s = build();
    await s.hydrate("v1");
    expect(s.themeMode()).toBe("dark");

    s.resetForVaultSwitch();
    await s.hydrate("v2");
    expect(s.themeMode()).toBe("system");
    expect(s.resolvedTheme()).toBe("light");
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
    expect(s.value("properties.default_currency")).toBe("eur");
  });

  it("applies a falsy stored value rather than the fallback", async () => {
    stored.mockImplementation((_v: string, key: string) =>
      Promise.resolve(key === "wikilinks.rewrite_broken_links_on_rename" ? false : null),
    );
    const s = build();
    await s.hydrate("v1");
    expect(s.rewriteBrokenLinks()).toBe(false);
  });

  it("falls back to each plugin's and block's default on a rejected read", async () => {
    stored.mockRejectedValue(new Error("index unavailable"));
    registerCorePlugins([
      {
        id: "probe",
        name: "Probe",
        description: "",
        settingKey: "plugins.dataview_enabled",
        defaultEnabled: true,
      },
    ]);
    const s = build();
    await s.hydrate("v1");
    expect(s.corePlugins()).toMatchObject({ probe: true });
    expect(s.value("properties.default_currency")).toBe("usd");
  });

  it("issues every read before any of them resolves", async () => {
    const pending: Array<() => void> = [];
    stored.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(null))),
    );
    const s = build();
    const done = s.hydrate("v1");
    await Promise.resolve();
    expect(pending.length).toBe(stored.mock.calls.length);
    expect(pending.length).toBeGreaterThan(1);
    pending.forEach((resolve) => resolve());
    await done;
  });
});

describe("applyChanged", () => {
  it("applies the one changed key from the event without re-reading any", () => {
    const s = build();
    s.applyChanged("properties.default_currency", "eur");
    s.applyChanged("editor.live_tab_limit", 0);
    s.applyChanged("appearance.theme_mode", "dark");
    expect(s.value("properties.default_currency")).toBe("eur");
    expect(s.liveTabLimit()).toBe(1);
    expect(s.themeMode()).toBe("dark");
    expect(stored).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  });

  it("restores the default when the event carries no value", () => {
    const s = build();
    s.applyChanged("properties.default_currency", "eur");
    s.applyChanged("properties.default_currency", null);
    expect(s.value("properties.default_currency")).toBe("usd");
  });

  it("ignores a key nothing registered", () => {
    const s = build();
    expect(() => s.applyChanged("nobody.owns_this", true)).not.toThrow();
  });
});

describe("resetForVaultSwitch", () => {
  it("drops per-vault view state without persisting anything", () => {
    const s = build();
    s.setRawOverride(true);
    s.toggleRightSidebar();
    s.setRightSidebarPanelValue("second-panel");
    s.setLeftSidebarModeValue("second-mode");
    s.setShortcutOverridesValue({ "file.new": "Mod-J" });
    written.mockClear();

    s.resetForVaultSwitch();

    expect(s.rawOverride()).toBe(null);
    expect(s.rightSidebarCollapsed()).toBe(false);
    expect(s.rightSidebarPanel()).toBe("first-panel");
    expect(s.leftSidebarMode()).toBe("first-mode");
    expect(s.shortcutOverrides()).toEqual({});
    expect(written).not.toHaveBeenCalled();
  });

  it("drops the outgoing vault's plugin and block settings", () => {
    const s = build();
    s.setCorePlugin("dataview", "plugins.dataview_enabled", false);
    s.setValue(VAULT_PATH_SEGMENT.settingKey, false);
    s.toggle("statusbar.enabled");
    expect(s.corePlugins()).toEqual({ dataview: false });
    expect(s.value(VAULT_PATH_SEGMENT.settingKey)).toBe(false);
    expect(s.value("statusbar.enabled")).toBe(false);

    s.resetForVaultSwitch();

    expect(s.corePlugins()).toEqual({});
    expect(s.value(VAULT_PATH_SEGMENT.settingKey)).toBe(true);
    expect(s.value("statusbar.enabled")).toBe(true);
  });
});

describe("a block's commands follow its toggle", () => {
  const graphKey = (s: ReturnType<typeof build>) =>
    s.effectiveBindings().find((b) => b.command === GRAPH_COMMAND.id)?.key;

  it("unbinds the command while the block is off and keeps the override", () => {
    const s = build();
    s.setShortcutOverridesValue({ [GRAPH_COMMAND.id]: "Mod-Shift-j" });
    expect(graphKey(s)).toBe("Mod-Shift-j");
    written.mockClear();

    s.setCorePlugin(GRAPH_PLUGIN.id, GRAPH_PLUGIN.settingKey, false);

    expect(graphKey(s)).toBeUndefined();
    expect(s.activeCommands().some((c) => c.id === GRAPH_COMMAND.id)).toBe(
      false,
    );
    expect(s.shortcutOverrides()).toEqual({ [GRAPH_COMMAND.id]: "Mod-Shift-j" });
    expect(written).not.toHaveBeenCalledWith(
      "v1",
      "shortcuts.overrides",
      expect.anything(),
    );
    expect(written).toHaveBeenCalledWith(
      "v1",
      GRAPH_PLUGIN.settingKey,
      false,
    );

    s.setCorePlugin(GRAPH_PLUGIN.id, GRAPH_PLUGIN.settingKey, true);

    expect(graphKey(s)).toBe("Mod-Shift-j");
  });

  it("hands out the same binding table when a toggle changes no binding", () => {
    const s = build();
    const before = s.effectiveBindings();
    s.setCorePlugin("dataview", "plugins.dataview_enabled", false);
    expect(s.effectiveBindings()).toBe(before);
  });
});
