import { describe, expect, it } from "vitest";

import { coerceValue } from "./coerce";

describe("coerceValue → string", () => {
  it("keeps a string non-lossily", () => {
    expect(coerceValue("foo", "string")).toEqual({
      value: "foo",
      lossy: false,
    });
  });

  it("renders a number as a string non-lossily", () => {
    expect(coerceValue(7, "string")).toEqual({ value: "7", lossy: false });
  });

  it("flags a nested mapping coerced to string as lossy", () => {
    const result = coerceValue({ x: 1 }, "string");
    expect(result.lossy).toBe(true);
    expect(typeof result.value).toBe("string");
  });
});

describe("coerceValue → number", () => {
  it("parses a numeric string non-lossily", () => {
    expect(coerceValue("42", "number")).toEqual({ value: 42, lossy: false });
  });

  it("falls back to 0 and flags lossy for a non-numeric string", () => {
    expect(coerceValue("abc", "number")).toEqual({ value: 0, lossy: true });
  });

  it("keeps a number non-lossily", () => {
    expect(coerceValue(7, "number")).toEqual({ value: 7, lossy: false });
  });
});

describe("coerceValue → boolean", () => {
  it("reads truthy words non-lossily", () => {
    expect(coerceValue("yes", "boolean")).toEqual({
      value: true,
      lossy: false,
    });
  });

  it("reads falsy words non-lossily", () => {
    expect(coerceValue("no", "boolean")).toEqual({
      value: false,
      lossy: false,
    });
  });

  it("falls back to false and flags lossy for an unrecognized string", () => {
    expect(coerceValue("maybe", "boolean")).toEqual({
      value: false,
      lossy: true,
    });
  });
});

describe("coerceValue → date", () => {
  it("keeps an ISO-date-shaped string non-lossily", () => {
    expect(coerceValue("2026-05-13", "date")).toEqual({
      value: "2026-05-13",
      lossy: false,
    });
  });

  it("falls back to empty and flags lossy for a non-date string", () => {
    expect(coerceValue("foo", "date")).toEqual({ value: "", lossy: true });
  });
});

describe("coerceValue → list", () => {
  it("wraps a scalar into a single-element list non-lossily", () => {
    expect(coerceValue("foo", "list-of-strings")).toEqual({
      value: ["foo"],
      lossy: false,
    });
  });

  it("keeps a string array non-lossily", () => {
    expect(coerceValue(["a", "b"], "list-of-tags")).toEqual({
      value: ["a", "b"],
      lossy: false,
    });
  });

  it("stringifies a mixed array and flags lossy", () => {
    const result = coerceValue([1, "b"], "list-of-strings");
    expect(result.value).toEqual(["1", "b"]);
    expect(result.lossy).toBe(true);
  });
});
