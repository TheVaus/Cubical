import { describe, expect, it } from "vitest";

import { inferType } from "./inferType";

describe("inferType", () => {
  it("infers boolean from true", () => {
    expect(inferType("archived", true)).toBe("boolean");
  });

  it("infers boolean from false", () => {
    expect(inferType("archived", false)).toBe("boolean");
  });

  it("infers number from a plain number", () => {
    expect(inferType("count", 7)).toBe("number");
  });

  it("infers date from an ISO-date-shaped string", () => {
    expect(inferType("created", "2026-05-13")).toBe("date");
  });

  it("infers string from a non-date string", () => {
    expect(inferType("title", "foo")).toBe("string");
  });

  it("does not infer date from a date-like-but-wrong-shape string", () => {
    expect(inferType("created", "2026/05/13")).toBe("string");
    expect(inferType("created", "2026-5-3")).toBe("string");
  });

  it("infers list-of-strings from a string array on an ordinary key", () => {
    expect(inferType("authors", ["a", "b"])).toBe("list-of-strings");
  });

  it("infers list-of-tags from a string array on the `tags` key", () => {
    expect(inferType("tags", ["a", "b"])).toBe("list-of-tags");
  });

  it("infers list-of-strings (not tags) from the `aliases` key", () => {
    // Deviation from spec §2.4: aliases are note names, not tags
    // (document-model.md §5.6). Confirmed with the operator.
    expect(inferType("aliases", ["Old Name", "ON"])).toBe("list-of-strings");
  });

  it("infers list-of-tags from an empty array on the `tags` key", () => {
    expect(inferType("tags", [])).toBe("list-of-tags");
  });

  it("infers list-of-strings from an empty array on an ordinary key", () => {
    expect(inferType("authors", [])).toBe("list-of-strings");
  });

  it("falls back to raw for a nested mapping", () => {
    expect(inferType("nested", { x: 1 })).toBe("raw");
  });

  it("falls back to raw for a mixed-type array", () => {
    expect(inferType("mixed", ["a", 1, true])).toBe("raw");
  });

  it("falls back to raw for an array of numbers", () => {
    expect(inferType("nums", [1, 2, 3])).toBe("raw");
  });

  it("falls back to raw for a null value", () => {
    expect(inferType("empty", null)).toBe("raw");
  });
});
