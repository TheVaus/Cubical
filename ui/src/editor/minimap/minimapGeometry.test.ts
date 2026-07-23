import { describe, expect, it } from "vitest";
import {
  fractionFromClientY,
  scrollTopForFraction,
  indicatorRect,
  lineHeightFor,
} from "./minimapGeometry";

describe("fractionFromClientY", () => {
  it("maps a click within the strip to a [0,1] fraction", () => {
    expect(fractionFromClientY(150, 100, 200)).toBeCloseTo(0.25);
  });
  it("clamps above and below the strip", () => {
    expect(fractionFromClientY(50, 100, 200)).toBe(0);
    expect(fractionFromClientY(999, 100, 200)).toBe(1);
  });
  it("returns 0 for a zero-height strip", () => {
    expect(fractionFromClientY(150, 100, 0)).toBe(0);
  });
});

describe("scrollTopForFraction", () => {
  const vp = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  it("centers the fraction in the viewport", () => {
    expect(scrollTopForFraction(0.5, vp)).toBe(400);
  });
  it("clamps to [0, scrollHeight - clientHeight]", () => {
    expect(scrollTopForFraction(0, vp)).toBe(0);
    expect(scrollTopForFraction(1, vp)).toBe(800);
  });
});

describe("indicatorRect", () => {
  it("sizes and positions the indicator from viewport ratios", () => {
    const r = indicatorRect(
      { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 },
      100,
    );
    expect(r.height).toBeCloseTo(20);
    expect(r.top).toBeCloseTo(50);
  });
  it("clamps a tiny indicator to a minimum height and keeps it in bounds", () => {
    const r = indicatorRect(
      { scrollTop: 1000, scrollHeight: 1000, clientHeight: 1 },
      100,
    );
    expect(r.height).toBeGreaterThanOrEqual(2);
    expect(r.top + r.height).toBeLessThanOrEqual(100);
  });
  it("fills the strip when there is nothing to scroll", () => {
    const r = indicatorRect(
      { scrollTop: 0, scrollHeight: 0, clientHeight: 200 },
      100,
    );
    expect(r).toEqual({ top: 0, height: 100 });
  });
});

describe("lineHeightFor", () => {
  it("caps at 4px for short documents", () => {
    expect(lineHeightFor(5, 600)).toBe(4);
  });
  it("scales to fit long documents (no floor)", () => {
    expect(lineHeightFor(1200, 600)).toBeCloseTo(0.5);
  });
  it("handles a zero line count", () => {
    expect(lineHeightFor(0, 600)).toBe(4);
  });
});
