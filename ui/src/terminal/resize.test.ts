import { describe, expect, it } from "vitest";

import { isUsableSize, sizeChanged } from "./resize";

describe("isUsableSize", () => {
  it("rejects sizes a pty cannot be given", () => {
    expect(isUsableSize(null)).toBe(false);
    expect(isUsableSize({ cols: 0, rows: 24 })).toBe(false);
    expect(isUsableSize({ cols: 80, rows: 0 })).toBe(false);
    expect(isUsableSize({ cols: Number.NaN, rows: 24 })).toBe(false);
  });

  it("accepts a real measured size", () => {
    expect(isUsableSize({ cols: 80, rows: 24 })).toBe(true);
  });
});

describe("sizeChanged", () => {
  it("reports the first usable size", () => {
    expect(sizeChanged(null, { cols: 80, rows: 24 })).toBe(true);
  });

  it("stays quiet when nothing moved, so the pty is not spammed", () => {
    expect(sizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
  });

  it("reports a change on either axis", () => {
    expect(sizeChanged({ cols: 80, rows: 24 }, { cols: 120, rows: 24 })).toBe(true);
    expect(sizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 40 })).toBe(true);
  });

  it("never reports an unusable size as a change", () => {
    expect(sizeChanged({ cols: 80, rows: 24 }, { cols: 0, rows: 24 })).toBe(false);
  });
});
