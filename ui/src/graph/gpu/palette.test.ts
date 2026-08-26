import { describe, expect, it } from "vitest";

import { packRgba } from "./instances";
import { parseColour } from "./palette";

describe("colour parsing", () => {
  it("reads a six-digit hex token", () => {
    expect(parseColour("#4f6d68")).toBe(packRgba(0x4f, 0x6d, 0x68, 1));
  });

  it("expands a three-digit hex token", () => {
    expect(parseColour("#abc")).toBe(packRgba(0xaa, 0xbb, 0xcc, 1));
  });

  it("tolerates the whitespace getPropertyValue leaves in place", () => {
    expect(parseColour("  #4f6d68 ")).toBe(parseColour("#4f6d68"));
  });

  it("applies the alpha argument, which is how edges are dimmed", () => {
    expect(parseColour("#000000", 0.5)).toBe(packRgba(0, 0, 0, 0.5));
  });

  it("reads rgb() and rgba(), which is what some browsers resolve tokens to", () => {
    expect(parseColour("rgb(79, 109, 104)")).toBe(parseColour("#4f6d68"));
    expect(parseColour("rgba(0, 0, 0, 0.5)")).toBe(packRgba(0, 0, 0, 0.5));
  });

  it("falls back to a visible colour rather than transparent on an unknown format", () => {
    const packed = parseColour("oklch(0.7 0.1 200)");
    expect(packed & 0xff).toBe(255);
  });
});
