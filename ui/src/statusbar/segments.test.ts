import { describe, expect, it } from "vitest";
import {
  STATUSBAR_DEFAULT,
  STATUSBAR_ENABLED_KEY,
  registerStatusbarSegments,
  statusbarBlockSettings,
} from "./statusbarSettings";
import { STATUSBAR_SEGMENTS, VAULT_PATH_SEGMENT } from "./segments";

registerStatusbarSegments(STATUSBAR_SEGMENTS);

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

  it("contributes the master key and every segment key, with its default", () => {
    const declared = statusbarBlockSettings();
    expect(declared[0]).toEqual({
      key: STATUSBAR_ENABLED_KEY,
      fallback: STATUSBAR_DEFAULT,
    });
    expect(declared.slice(1)).toEqual(
      STATUSBAR_SEGMENTS.map((seg) => ({
        key: seg.settingKey,
        fallback: seg.defaultVisible,
      })),
    );
  });

  it("ships every segment visible, so the bar is whole until configured", () => {
    expect(VAULT_PATH_SEGMENT.defaultVisible).toBe(true);
    expect(STATUSBAR_SEGMENTS.every((seg) => seg.defaultVisible)).toBe(true);
  });
});
