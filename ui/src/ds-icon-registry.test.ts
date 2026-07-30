import { describe, it, expect } from "vitest";
import { ICONS, type IconName } from "@ds/components/graphics/Icon/icons";

const EXPECTED: IconName[] = [
  "plus", "folder-plus", "info", "chevron-right", "chevron-down",
  "close", "edit", "settings", "warning", "sun", "moon", "link",
  "file-text", "bar-chart", "palette", "puzzle", "library", "keyboard",
  "hash", "command", "terminal",
];

describe("DS icon registry", () => {
  it("registry keys exactly match the expected IconName set", () => {
    expect(Object.keys(ICONS).sort()).toEqual([...EXPECTED].sort());
  });

  it("every entry is non-empty SVG geometry", () => {
    for (const [name, markup] of Object.entries(ICONS)) {
      expect(markup.length, name).toBeGreaterThan(0);
      expect(markup, name).toMatch(/<(path|circle|line|rect|polyline|polygon)\b/);
    }
  });
});
