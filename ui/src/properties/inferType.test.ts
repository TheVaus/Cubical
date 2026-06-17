import { describe, expect, it } from "vitest";

import { inferType } from "./inferType";

describe("inferType", () => {
  it("infers boolean from true/false", () => {
    expect(inferType(true)).toBe("boolean");
    expect(inferType(false)).toBe("boolean");
  });

  it("infers int from a whole number, float from a fractional one", () => {
    expect(inferType(7)).toBe("int");
    expect(inferType(-3)).toBe("int");
    expect(inferType(0.8)).toBe("float");
  });

  it("infers date from an ISO-date-shaped string", () => {
    expect(inferType("2026-05-13")).toBe("date");
  });

  it("infers string from a non-date string", () => {
    expect(inferType("foo")).toBe("string");
    expect(inferType("2026/05/13")).toBe("string");
    expect(inferType("2026-5-3")).toBe("string");
  });

  it("infers list-of-strings from a string array (any key)", () => {
    expect(inferType(["a", "b"])).toBe("list-of-strings");
    expect(inferType(["#draft", "research"])).toBe("list-of-strings");
    expect(inferType([])).toBe("list-of-strings");
  });

  it("falls back to raw for non-modelable values", () => {
    expect(inferType({ x: 1 })).toBe("raw");
    expect(inferType(["a", 1, true])).toBe("raw");
    expect(inferType([1, 2, 3])).toBe("raw");
    expect(inferType(null)).toBe("raw");
  });
});
