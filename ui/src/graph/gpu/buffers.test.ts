import { describe, expect, it } from "vitest";

import { align, growTo } from "./buffers";

describe("buffer sizing", () => {
  it("aligns to four bytes, as WebGPU writeBuffer requires", () => {
    expect(align(1)).toBe(4);
    expect(align(4)).toBe(4);
    expect(align(5)).toBe(8);
    expect(align(0)).toBe(4);
  });

  it("grows by doubling so a converging layout does not reallocate per frame", () => {
    expect(growTo(1)).toBe(16);
    expect(growTo(16)).toBe(16);
    expect(growTo(17)).toBe(32);
    expect(growTo(1000)).toBe(1024);
  });

  it("never returns a capacity below what was asked for", () => {
    for (const n of [1, 33, 4097, 123456]) {
      expect(growTo(n)).toBeGreaterThanOrEqual(n);
    }
  });
});
