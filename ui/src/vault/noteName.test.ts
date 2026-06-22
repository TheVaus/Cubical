import { describe, it, expect } from "vitest";

import { isValidNoteName, noteNameError } from "./noteName";

describe("isValidNoteName", () => {
  it("accepts a plain name (with or without .md)", () => {
    expect(isValidNoteName("Gandalf")).toBe(true);
    expect(isValidNoteName("Gandalf.md")).toBe(true);
    expect(isValidNoteName("Daily Note 2026")).toBe(true);
  });

  it("rejects a dotted name (would shadow property-ref syntax)", () => {
    expect(isValidNoteName("2026.06.20")).toBe(false);
    expect(isValidNoteName("v1.2")).toBe(false);
    expect(isValidNoteName("2026.06.20.md")).toBe(false);
  });

  it("rejects an empty base name", () => {
    expect(isValidNoteName("")).toBe(false);
    expect(isValidNoteName(".md")).toBe(false);
  });

  it("explains why in noteNameError", () => {
    expect(noteNameError("v1.2")).toContain("dot");
  });
});
