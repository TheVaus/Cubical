import { describe, expect, test } from "vitest";
import {
  corePluginActive,
  corePluginEnabled,
  missingRequirements,
  registerCorePlugins,
  registeredCorePlugins,
  type CorePlugin,
} from "./corePlugins";

const onByDefault: CorePlugin = {
  id: "fixture-on",
  name: "On",
  description: "",
  settingKey: "plugins.dataview_enabled",
  defaultEnabled: true,
};

const offByDefault: CorePlugin = {
  id: "fixture-off",
  name: "Off",
  description: "",
  settingKey: "plugins.terminal_enabled",
  defaultEnabled: false,
};

const dependent: CorePlugin = {
  id: "fixture-dependent",
  name: "Dependent",
  description: "",
  settingKey: "plugins.equations_enabled",
  defaultEnabled: true,
  requires: ["fixture-on"],
};

describe("an empty registry", () => {
  test("declares no plugin of its own", () => {
    expect(registeredCorePlugins()).toEqual([]);
  });

  test("resolves every id as inactive rather than throwing", () => {
    expect(corePluginActive({}, "fixture-on")).toBe(false);
  });
});

describe("registerCorePlugins", () => {
  test("appends in the order given, once per id", () => {
    registerCorePlugins([onByDefault, dependent]);
    registerCorePlugins([offByDefault, onByDefault]);
    expect(registeredCorePlugins().map((p) => p.id)).toEqual([
      "fixture-on",
      "fixture-dependent",
      "fixture-off",
    ]);
  });
});

describe("corePluginEnabled", () => {
  test("uses the stored value when present", () => {
    expect(corePluginEnabled({ "fixture-on": false }, onByDefault)).toBe(false);
    expect(corePluginEnabled({ "fixture-off": true }, offByDefault)).toBe(true);
  });

  test("falls back to defaultEnabled when absent", () => {
    expect(corePluginEnabled({}, onByDefault)).toBe(true);
    expect(corePluginEnabled({}, offByDefault)).toBe(false);
  });
});

describe("corePluginActive", () => {
  test("looks a registered plugin up by id and applies the stored value", () => {
    expect(corePluginActive({ "fixture-on": false }, "fixture-on")).toBe(false);
    expect(corePluginActive({ "fixture-off": true }, "fixture-off")).toBe(true);
  });

  test("falls back to the plugin's default when unset", () => {
    expect(corePluginActive({}, "fixture-on")).toBe(true);
    expect(corePluginActive({}, "fixture-off")).toBe(false);
  });

  test("is false for an unknown id rather than throwing", () => {
    expect(corePluginActive({}, "no-such-plugin")).toBe(false);
  });

  test("accepts a plugin object and an id interchangeably", () => {
    expect(corePluginActive({ "fixture-on": false }, onByDefault)).toBe(
      corePluginActive({ "fixture-on": false }, "fixture-on"),
    );
  });

  test("is false for a plugin switched on whose requirement is off", () => {
    const state = { "fixture-on": false };
    expect(corePluginEnabled(state, dependent)).toBe(true);
    expect(corePluginActive(state, dependent)).toBe(false);
    expect(corePluginActive({}, dependent)).toBe(true);
  });
});

describe("missingRequirements", () => {
  test("is empty when every requirement is on", () => {
    expect(missingRequirements({}, dependent)).toEqual([]);
  });

  test("names the plugin that is off, so the UI can say which", () => {
    expect(
      missingRequirements({ "fixture-on": false }, dependent).map((p) => p.name),
    ).toEqual(["On"]);
  });

  test("is empty for a plugin that requires nothing", () => {
    expect(missingRequirements({ "fixture-on": false }, offByDefault)).toEqual(
      [],
    );
  });
});
