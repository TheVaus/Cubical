import { describe, expect, test } from "vitest";

import {
  corePluginActive,
  corePluginEnabled,
  missingRequirements,
  registerCorePlugins,
} from "../settings/corePlugins";
import { EQUATIONS_PLUGIN } from "./equationRegistration";
import { MATH_PLUGIN } from "./mathRegistration";
import { PROPERTY_REFS_PLUGIN } from "./propertyRefRegistration";

registerCorePlugins([PROPERTY_REFS_PLUGIN, MATH_PLUGIN, EQUATIONS_PLUGIN]);

describe("editor plugin entries", () => {
  test("each points at its own doc", () => {
    expect(
      [PROPERTY_REFS_PLUGIN, MATH_PLUGIN, EQUATIONS_PLUGIN].map((p) => p.docId),
    ).toEqual(["property-refs", "math", "equations"]);
  });

  test("ships property references default-on", () => {
    expect(PROPERTY_REFS_PLUGIN.settingKey).toBe(
      "plugins.property_refs_enabled",
    );
    expect(PROPERTY_REFS_PLUGIN.defaultEnabled).toBe(true);
  });

  test("ships math default-on — it renders, it grants nothing", () => {
    expect(MATH_PLUGIN.settingKey).toBe("plugins.math_enabled");
    expect(MATH_PLUGIN.defaultEnabled).toBe(true);
    expect(missingRequirements({ "property-refs": false }, MATH_PLUGIN)).toEqual(
      [],
    );
  });
});

describe("EQUATIONS_PLUGIN", () => {
  test("ships default-on with its own setting key", () => {
    expect(EQUATIONS_PLUGIN.settingKey).toBe("plugins.equations_enabled");
    expect(EQUATIONS_PLUGIN.defaultEnabled).toBe(true);
  });

  test("declares its dependency on property references", () => {
    expect(EQUATIONS_PLUGIN.requires).toEqual(["property-refs"]);
  });

  test("is inactive while property references is off, though its own switch is on", () => {
    expect(corePluginEnabled({ "property-refs": false }, EQUATIONS_PLUGIN)).toBe(
      true,
    );
    expect(corePluginActive({ "property-refs": false }, EQUATIONS_PLUGIN)).toBe(
      false,
    );
    expect(corePluginActive({}, EQUATIONS_PLUGIN)).toBe(true);
  });

  test("names the plugin that is off, so the UI can say which", () => {
    expect(
      missingRequirements({ "property-refs": false }, EQUATIONS_PLUGIN).map(
        (p) => p.name,
      ),
    ).toEqual(["Property references"]);
  });

  test("does not depend on the math plugin", () => {
    expect(EQUATIONS_PLUGIN.requires ?? []).not.toContain("math");
    expect(corePluginActive({ math: false }, "equations")).toBe(true);
  });
});
