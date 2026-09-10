import { describe, expect, test } from "vitest";

import {
  corePluginActive,
  corePluginEnabled,
  registeredCorePlugins,
} from "../settings/corePlugins";
import { registeredStatusbarSegments } from "../settings/statusbarSettings";
import { STATUSBAR_SEGMENTS } from "../statusbar/segments";
import { registerBlocks } from "./registerBlocks";

registerBlocks();

describe("registerBlocks", () => {
  test("assembles the plugin list in the order the Plugins pane shows it", () => {
    expect(registeredCorePlugins().map((p) => p.id)).toEqual([
      "dataview",
      "property-refs",
      "math",
      "equations",
      "terminal",
      "graph-view",
    ]);
  });

  test("is idempotent, so a second boot does not duplicate a row", () => {
    const before = registeredCorePlugins().length;
    registerBlocks();
    expect(registeredCorePlugins()).toHaveLength(before);
    expect(registeredStatusbarSegments()).toHaveLength(
      STATUSBAR_SEGMENTS.length,
    );
  });

  test("gives every plugin a distinct id and setting key", () => {
    const plugins = registeredCorePlugins();
    expect(new Set(plugins.map((p) => p.id)).size).toBe(plugins.length);
    expect(new Set(plugins.map((p) => p.settingKey)).size).toBe(plugins.length);
  });

  test("ships the terminal entry, default-OFF — it grants an unsandboxed capability", () => {
    const terminal = registeredCorePlugins().find((p) => p.id === "terminal")!;
    expect(terminal.settingKey).toBe("plugins.terminal_enabled");
    expect(terminal.defaultEnabled).toBe(false);
    expect(corePluginEnabled({}, terminal)).toBe(false);
    expect(corePluginActive({}, "terminal")).toBe(false);
  });

  test("ships the graph entry, default-on", () => {
    expect(corePluginActive({}, "graph-view")).toBe(true);
  });

  test("hands settings the statusbar's segments in bar order", () => {
    expect(registeredStatusbarSegments().map((s) => s.id)).toEqual([
      "vault_path",
      "file_path",
      "word_count",
      "block_count",
    ]);
  });
});
