import { describe, expect, test } from "vitest";

import { corePluginEnabled } from "../settings/corePlugins";
import { QUERY_PLUGIN } from "./registration";

describe("QUERY_PLUGIN", () => {
  test("ships default-on", () => {
    expect(QUERY_PLUGIN.settingKey).toBe("plugins.dataview_enabled");
    expect(QUERY_PLUGIN.defaultEnabled).toBe(true);
    expect(corePluginEnabled({}, QUERY_PLUGIN)).toBe(true);
  });

  test("shows as Query while keeping its stored id and key", () => {
    expect(QUERY_PLUGIN.name).toBe("Query");
    expect(QUERY_PLUGIN.id).toBe("dataview");
    expect(QUERY_PLUGIN.settingKey).toBe("plugins.dataview_enabled");
  });

  test("carries its help page and requires nothing", () => {
    expect(typeof QUERY_PLUGIN.doc).toBe("function");
    expect(QUERY_PLUGIN.requires ?? []).toEqual([]);
  });
});
