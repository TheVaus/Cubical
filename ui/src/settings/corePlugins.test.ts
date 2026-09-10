import { describe, expect, test } from "vitest";
import {
  BUILTIN_PLUGINS,
  corePluginActive,
  corePluginEnabled,
  missingRequirements,
  registerCorePlugins,
  registeredCorePlugins,
  type CorePlugin,
} from "./corePlugins";

const dataview = BUILTIN_PLUGINS.find((p) => p.id === "dataview")!;

describe("corePluginEnabled", () => {
  test("uses the stored value when present", () => {
    expect(corePluginEnabled({ dataview: false }, dataview)).toBe(false);
    expect(corePluginEnabled({ dataview: true }, dataview)).toBe(true);
  });
  test("falls back to defaultEnabled when absent", () => {
    expect(corePluginEnabled({}, dataview)).toBe(dataview.defaultEnabled);
  });
});

describe("corePluginActive", () => {
  test("looks a plugin up by id and applies the stored value", () => {
    expect(corePluginActive({ dataview: false }, "dataview")).toBe(false);
  });

  test("falls back to the plugin's default when unset", () => {
    expect(corePluginActive({}, "math")).toBe(true);
  });

  test("is false for an unknown id rather than throwing", () => {
    expect(corePluginActive({}, "no-such-plugin")).toBe(false);
  });

  test("accepts a plugin object and an id interchangeably", () => {
    expect(corePluginActive({ dataview: false }, dataview)).toBe(
      corePluginActive({ dataview: false }, "dataview"),
    );
  });

  test("is false for a plugin switched on whose requirement is off", () => {
    const equations = BUILTIN_PLUGINS.find((p) => p.id === "equations")!;
    expect(corePluginEnabled({ "property-refs": false }, equations)).toBe(true);
    expect(corePluginActive({ "property-refs": false }, equations)).toBe(false);
  });
});

describe("BUILTIN_PLUGINS", () => {
  test("ships the dataview entry, default-on", () => {
    expect(dataview.settingKey).toBe("plugins.dataview_enabled");
    expect(dataview.defaultEnabled).toBe(true);
  });

  test("shows the dataview entry as Query while keeping its stored id and key", () => {
    expect(dataview.name).toBe("Query");
    expect(dataview.id).toBe("dataview");
    expect(dataview.settingKey).toBe("plugins.dataview_enabled");
  });

  test("points the explainable plugins at a doc, and no others", () => {
    const withDocs = BUILTIN_PLUGINS.filter((p) => p.docId !== undefined);
    expect(withDocs.map((p) => p.docId)).toEqual([
      "query",
      "property-refs",
      "math",
      "equations",
    ]);
  });

  test("ships the property-refs entry, default-on", () => {
    const pr = BUILTIN_PLUGINS.find((p) => p.id === "property-refs")!;
    expect(pr).toBeDefined();
    expect(pr.settingKey).toBe("plugins.property_refs_enabled");
    expect(pr.defaultEnabled).toBe(true);
  });

  test("ships the math entry, default-on — it renders, it grants nothing", () => {
    const math = BUILTIN_PLUGINS.find((p) => p.id === "math")!;
    expect(math).toBeDefined();
    expect(math.settingKey).toBe("plugins.math_enabled");
    expect(math.defaultEnabled).toBe(true);
  });

  test("holds only the editor-hosted features, in pane order", () => {
    expect(BUILTIN_PLUGINS.map((p) => p.id)).toEqual([
      "dataview",
      "property-refs",
      "math",
      "equations",
    ]);
  });
});

describe("equations", () => {
  const equations = BUILTIN_PLUGINS.find((p) => p.id === "equations")!;

  test("ships default-on with its own setting key", () => {
    expect(equations.settingKey).toBe("plugins.equations_enabled");
    expect(equations.defaultEnabled).toBe(true);
  });

  test("declares its dependency on property references", () => {
    expect(equations.requires).toEqual(["property-refs"]);
  });

  test("is inactive when a plugin it requires is off", () => {
    expect(corePluginActive({ "property-refs": false }, equations)).toBe(false);
    expect(corePluginActive({}, equations)).toBe(true);
  });

  test("does not depend on the math plugin", () => {
    expect(equations.requires ?? []).not.toContain("math");
    expect(corePluginActive({ math: false }, "equations")).toBe(true);
  });
});

describe("missingRequirements", () => {
  const equations = BUILTIN_PLUGINS.find((p) => p.id === "equations")!;

  test("is empty when every requirement is on", () => {
    expect(missingRequirements({}, equations)).toEqual([]);
  });

  test("names the plugin that is off, so the UI can say which", () => {
    expect(
      missingRequirements({ "property-refs": false }, equations).map(
        (p) => p.name,
      ),
    ).toEqual(["Property references"]);
  });

  test("is empty for a plugin that requires nothing", () => {
    const math = BUILTIN_PLUGINS.find((p) => p.id === "math")!;
    expect(missingRequirements({ "property-refs": false }, math)).toEqual([]);
  });
});

describe("registerCorePlugins", () => {
  const needsProbe: CorePlugin = {
    id: "fixture-dependent",
    name: "Dependent",
    description: "",
    settingKey: "plugins.graph_view_enabled",
    defaultEnabled: true,
    requires: ["fixture-probe"],
  };
  const probe: CorePlugin = {
    id: "fixture-probe",
    name: "Probe",
    description: "",
    settingKey: "plugins.terminal_enabled",
    defaultEnabled: false,
  };

  test("appends after the built-ins in the order given, once per id", () => {
    registerCorePlugins([needsProbe, probe]);
    registerCorePlugins([probe]);
    expect(registeredCorePlugins().map((p) => p.id)).toEqual([
      ...BUILTIN_PLUGINS.map((p) => p.id),
      "fixture-dependent",
      "fixture-probe",
    ]);
  });

  test("resolves a requirement on a registered plugin, not only a built-in", () => {
    expect(corePluginActive({}, "fixture-dependent")).toBe(false);
    expect(missingRequirements({}, needsProbe).map((p) => p.id)).toEqual([
      "fixture-probe",
    ]);
    expect(corePluginActive({ "fixture-probe": true }, needsProbe)).toBe(true);
  });
});
