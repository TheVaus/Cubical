import { describe, expect, test } from "vitest";
import {
  CORE_PLUGINS,
  corePluginActive,
  corePluginEnabled,
  missingRequirements,
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

describe("corePluginActive", () => {
  test("looks a plugin up by id and applies the stored value", () => {
    expect(corePluginActive({ dataview: false }, "dataview")).toBe(false);
  });

  test("falls back to the plugin's default when unset", () => {
    expect(corePluginActive({}, "math")).toBe(true);
    expect(corePluginActive({}, "terminal")).toBe(false);
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
    const equations = CORE_PLUGINS.find((p) => p.id === "equations")!;
    expect(corePluginEnabled({ "property-refs": false }, equations)).toBe(true);
    expect(corePluginActive({ "property-refs": false }, equations)).toBe(false);
  });
});

describe("CORE_PLUGINS", () => {
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
    const withDocs = CORE_PLUGINS.filter((p) => p.docId !== undefined);
    expect(withDocs.map((p) => p.docId)).toEqual([
      "query",
      "property-refs",
      "math",
      "equations",
    ]);
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

describe("equations", () => {
  const equations = CORE_PLUGINS.find((p) => p.id === "equations")!;

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
  const equations = CORE_PLUGINS.find((p) => p.id === "equations")!;

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
    const math = CORE_PLUGINS.find((p) => p.id === "math")!;
    expect(missingRequirements({ "property-refs": false }, math)).toEqual([]);
  });
});
