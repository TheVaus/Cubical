import { describe, expect, test } from "vitest";
import { CORE_PLUGINS, corePluginEnabled } from "./corePlugins";

const dataview = CORE_PLUGINS.find((p) => p.id === "dataview")!;

describe("corePluginEnabled", () => {
  test("uses the stored value when present", () => {
    expect(corePluginEnabled({ dataview: false }, dataview)).toBe(false);
    expect(corePluginEnabled({ dataview: true }, dataview)).toBe(true);
  });
  test("falls back to defaultEnabled when absent", () => {
    expect(corePluginEnabled({}, dataview)).toBe(dataview.defaultEnabled);
  });
});

describe("CORE_PLUGINS", () => {
  test("ships the dataview entry, default-on", () => {
    expect(dataview.settingKey).toBe("plugins.dataview_enabled");
    expect(dataview.defaultEnabled).toBe(true);
  });
});
