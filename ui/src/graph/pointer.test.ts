import { describe, expect, it } from "vitest";

import {
  devicePoint,
  wheelFactor,
  MAX_WHEEL_STEP,
  WHEEL_SENSITIVITY,
} from "./pointer";

describe("wheel to zoom factor", () => {
  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, false)).toBeLessThan(1);
  });

  it("is exactly neutral at zero, so a stray event does not drift the camera", () => {
    expect(wheelFactor(0, false)).toBe(1);
  });

  it("is multiplicatively symmetric, so a scroll and its reverse cancel", () => {
    expect(wheelFactor(120, false) * wheelFactor(-120, false)).toBeCloseTo(1, 10);
  });

  it("never returns a negative or zero factor, however violent the scroll", () => {
    for (const delta of [-100000, -1e6, 1e6]) {
      expect(wheelFactor(delta, false)).toBeGreaterThan(0);
    }
  });

  it("caps a single event's step, so one flick cannot jump the whole zoom range", () => {
    expect(wheelFactor(-1e6, false)).toBe(MAX_WHEEL_STEP);
    expect(wheelFactor(1e6, false)).toBeCloseTo(1 / MAX_WHEEL_STEP, 10);
  });

  it("ignores a non-finite delta rather than sending zoom to NaN", () => {
    expect(wheelFactor(Number.NaN, false)).toBe(1);
    expect(wheelFactor(Infinity, false)).toBe(1);
  });

  it("treats a ctrl-wheel pinch as a larger step", () => {
    expect(wheelFactor(-10, true)).toBeGreaterThan(wheelFactor(-10, false));
    expect(wheelFactor(-10, true)).toBeCloseTo(Math.exp(40 * WHEEL_SENSITIVITY));
  });
});

describe("pointer to device coordinates", () => {
  it("subtracts the element origin and scales by the pixel ratio", () => {
    expect(devicePoint({ clientX: 110, clientY: 60 }, { left: 10, top: 20 }, 2))
      .toEqual([200, 80]);
  });

  it("is identity at the origin with a ratio of one", () => {
    expect(devicePoint({ clientX: 0, clientY: 0 }, { left: 0, top: 0 }, 1))
      .toEqual([0, 0]);
  });
});
