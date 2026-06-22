import { describe, expect, it } from "vitest";

import { validateRenameTarget } from "./fileRename";

describe("validateRenameTarget", () => {
  it("rejects an empty target", () => {
    expect(validateRenameTarget("Daily.md", "")).toEqual({
      code: "empty",
      message: "Name cannot be empty.",
    });
  });

  it("rejects whitespace-only target", () => {
    expect(validateRenameTarget("Daily.md", "   ")).toEqual({
      code: "empty",
      message: "Name cannot be empty.",
    });
  });

  it("rejects an unchanged target", () => {
    expect(validateRenameTarget("Daily.md", "Daily.md")).toEqual({
      code: "same",
      message: "Name unchanged.",
    });
  });

  it("trims whitespace before comparing", () => {
    expect(validateRenameTarget("Daily.md", "  Daily.md  ")).toEqual({
      code: "same",
      message: "Name unchanged.",
    });
  });

  it("accepts a fresh target", () => {
    expect(validateRenameTarget("Daily.md", "Journal.md")).toBeNull();
  });

  it("accepts a target in a nested directory", () => {
    expect(
      validateRenameTarget("notes/Daily.md", "notes/Journal.md"),
    ).toBeNull();
  });

  it("rejects a dotted target (unreachable by [[ ]] link)", () => {
    const res = validateRenameTarget("Daily.md", "2026.06.20.md");
    expect(res?.code).toBe("dotted");
    expect(res?.message).toContain("dot");
  });

  it("allows a dot in a parent directory but not the note name", () => {
    expect(validateRenameTarget("Daily.md", "v1.2/Journal.md")?.code).not.toBe(
      "dotted",
    );
    expect(validateRenameTarget("Daily.md", "notes/v1.2.md")?.code).toBe(
      "dotted",
    );
  });
});
