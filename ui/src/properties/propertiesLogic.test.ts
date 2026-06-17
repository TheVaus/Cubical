import { describe, expect, it } from "vitest";

import type { PropertyType } from "./typeComments";
import {
  buildAnnotations,
  effectiveFormat,
  resolveType,
} from "./propertiesLogic";

describe("resolveType", () => {
  const map = new Map<string, PropertyType>([["price", { kind: "currency" }]]);

  it("uses the comment type when typed is enabled", () => {
    expect(resolveType(true, map, "price", 9.99)).toEqual({ kind: "currency" });
  });
  it("falls back to inference when no comment", () => {
    expect(resolveType(true, map, "count", 3)).toEqual({ kind: "int" });
  });
  it("ignores comments and infers when typed is disabled", () => {
    expect(resolveType(false, map, "price", 9.99)).toEqual({ kind: "float" });
  });
});

describe("effectiveFormat", () => {
  it("prefers the type's inline format, then the vault default", () => {
    expect(effectiveFormat({ kind: "date", format: "DD-MM-YY" }, "YYYY")).toBe(
      "DD-MM-YY",
    );
    expect(effectiveFormat({ kind: "date" }, "YYYY")).toBe("YYYY");
    expect(effectiveFormat({ kind: "date" }, undefined)).toBe("YYYY-MM-DD");
  });
});

describe("buildAnnotations", () => {
  const base = new Map<string, PropertyType>([
    ["a", { kind: "currency" }],
    ["b", { kind: "date" }],
  ]);

  it("copies unchanged when no override is given", () => {
    const out = buildAnnotations(base);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
  it("sets an overridden key", () => {
    const out = buildAnnotations(base, "a", { kind: "int" });
    expect(out.get("a")).toEqual({ kind: "int" });
    expect(out.get("b")).toEqual({ kind: "date" });
  });
  it("removes a key when override is null", () => {
    const out = buildAnnotations(base, "a", null);
    expect(out.has("a")).toBe(false);
  });
});
