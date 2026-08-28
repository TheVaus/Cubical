import { describe, expect, test } from "vitest";

import { CORE_PLUGINS } from "../corePlugins";
import { PLUGIN_DOCS } from "./index";

describe("PLUGIN_DOCS", () => {
  test("has an entry for every docId a plugin points at", () => {
    for (const plugin of CORE_PLUGINS) {
      if (plugin.docId === undefined) continue;
      expect(PLUGIN_DOCS[plugin.docId]).toBeDefined();
    }
  });

  test("titles the doc the same as the plugin that opens it", () => {
    for (const plugin of CORE_PLUGINS) {
      if (plugin.docId === undefined) continue;
      expect(PLUGIN_DOCS[plugin.docId].title).toBe(plugin.name);
    }
  });

  test("has no doc that nothing opens", () => {
    const reachable = new Set(
      CORE_PLUGINS.map((p) => p.docId).filter((id) => id !== undefined),
    );
    expect(Object.keys(PLUGIN_DOCS).sort()).toEqual([...reachable].sort());
  });
});
