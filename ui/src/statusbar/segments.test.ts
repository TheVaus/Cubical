import { describe, expect, it } from "vitest";
import {
  STATUSBAR_SEGMENTS,
  STATUSBAR_ENABLED_KEY,
  VAULT_PATH_SEGMENT,
  segmentVisible,
} from "./segments";

describe("statusbar segments", () => {
  it("exposes exactly the four configurable item segments", () => {
    expect(STATUSBAR_SEGMENTS.map((s) => s.id)).toEqual([
      "vault_path",
      "file_path",
      "word_count",
      "block_count",
    ]);
  });

  it("every segment id and settingKey is unique", () => {
    const ids = new Set(STATUSBAR_SEGMENTS.map((s) => s.id));
    const keys = new Set(STATUSBAR_SEGMENTS.map((s) => s.settingKey));
    expect(ids.size).toBe(STATUSBAR_SEGMENTS.length);
    expect(keys.size).toBe(STATUSBAR_SEGMENTS.length);
  });

  it("the master key is not one of the segment keys", () => {
    expect(STATUSBAR_SEGMENTS.map((s) => s.settingKey)).not.toContain(
      STATUSBAR_ENABLED_KEY,
    );
  });

  it("segmentVisible returns the stored value when present", () => {
    const seg = VAULT_PATH_SEGMENT;
    expect(segmentVisible({ [seg.settingKey]: false }, seg)).toBe(false);
    expect(segmentVisible({ [seg.settingKey]: true }, seg)).toBe(true);
  });

  it("segmentVisible falls back to the default (visible) when absent", () => {
    const seg = VAULT_PATH_SEGMENT;
    expect(segmentVisible({}, seg)).toBe(seg.defaultVisible);
    expect(seg.defaultVisible).toBe(true);
  });
});
