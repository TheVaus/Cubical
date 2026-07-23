import { describe, expect, it } from "vitest";

import { validateRenameTarget, reprefixNestedPath } from "./fileRename";

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

  it("allows a dot in a folder name (isFolder=true skips the dot restriction)", () => {
    expect(validateRenameTarget("projects", "v1.2", true)).toBeNull();
  });

  it("still rejects a dotted file name when isFolder is false (default)", () => {
    const result = validateRenameTarget("notes/foo.md", "notes/v1.2.md");
    expect(result?.code).toBe("dotted");
  });
});

describe("reprefixNestedPath", () => {
  it("swaps the prefix for a file nested directly under the renamed folder", () => {
    expect(reprefixNestedPath("projects/a.md", "projects", "work")).toBe(
      "work/a.md",
    );
  });

  it("swaps the prefix for a file nested several levels deep", () => {
    expect(
      reprefixNestedPath("projects/deep/deeper/a.md", "projects", "work"),
    ).toBe("work/deep/deeper/a.md");
  });

  it("returns null for a file outside the renamed folder", () => {
    expect(reprefixNestedPath("other/a.md", "projects", "work")).toBeNull();
  });

  it("returns null for the folder's own path (not a nested file)", () => {
    expect(reprefixNestedPath("projects", "projects", "work")).toBeNull();
  });

  it("doesn't false-positive on a sibling folder with a shared prefix", () => {
    expect(
      reprefixNestedPath("projects-archive/a.md", "projects", "work"),
    ).toBeNull();
  });
});
