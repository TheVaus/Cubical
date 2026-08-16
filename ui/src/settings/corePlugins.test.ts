import { describe, expect, test } from "vitest";
import {
  CORE_PLUGINS,
  corePluginEnabled,
  corePluginOn,
} from "./corePlugins";

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

describe("corePluginOn", () => {
  test("looks a plugin up by id and applies the stored value", () => {
    expect(corePluginOn({ dataview: false }, "dataview")).toBe(false);
  });

  test("falls back to the plugin's default when unset", () => {
    expect(corePluginOn({}, "math")).toBe(true);
    expect(corePluginOn({}, "terminal")).toBe(false);
  });

  test("is false for an unknown id rather than throwing", () => {
    expect(corePluginOn({}, "no-such-plugin")).toBe(false);
  });
});

describe("CORE_PLUGINS", () => {
  test("ships the dataview entry, default-on", () => {
    expect(dataview.settingKey).toBe("plugins.dataview_enabled");
    expect(dataview.defaultEnabled).toBe(true);
  });

  test("ships the property-refs entry, default-on", () => {
    const pr = CORE_PLUGINS.find((p) => p.id === "property-refs")!;
    expect(pr).toBeDefined();
    expect(pr.settingKey).toBe("plugins.property_refs_enabled");
    expect(pr.defaultEnabled).toBe(true);
  });

  test("ships the math entry, default-on — it renders, it grants nothing", () => {
    const math = CORE_PLUGINS.find((p) => p.id === "math")!;
    expect(math).toBeDefined();
    expect(math.settingKey).toBe("plugins.math_enabled");
    expect(math.defaultEnabled).toBe(true);
  });

  test("ships the terminal entry, default-OFF — it grants an unsandboxed capability", () => {
    const terminal = CORE_PLUGINS.find((p) => p.id === "terminal")!;
    expect(terminal).toBeDefined();
    expect(terminal.settingKey).toBe("plugins.terminal_enabled");
    expect(terminal.defaultEnabled).toBe(false);
    expect(corePluginEnabled({}, terminal)).toBe(false);
  });
});
