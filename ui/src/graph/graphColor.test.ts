import { describe, expect, it } from "vitest";

import {
  FOLDER_TOKENS,
  colourForFolder,
  folderOf,
  hashFolder,
  hueIndex,
} from "./graphColor";

describe("folder extraction", () => {
  it("takes the top-level folder of a nested path", () => {
    expect(folderOf("characters/Frodo.md")).toBe("characters");
    expect(folderOf("a/b/c.md")).toBe("a");
  });

  it("treats a root-level note as the empty folder", () => {
    expect(folderOf("Home.md")).toBe("");
  });

  it("treats a tag or ghost key with no slash as the empty folder", () => {
    expect(folderOf("work")).toBe("");
  });
});

describe("folder hue", () => {
  it("is deterministic: the same folder always gets the same hue", () => {
    for (const folder of ["characters", "concepts", "daily", "locations"]) {
      const first = hueIndex(folder);
      for (let i = 0; i < 50; i++) expect(hueIndex(folder)).toBe(first);
    }
  });

  it("puts the root folder in a fixed bucket rather than hashing the empty string", () => {
    expect(hueIndex("")).toBe(0);
  });

  it("stays inside the palette, whatever the folder name", () => {
    const names = ["a", "zzzzzzzzzzzz", "🙂/x", "..", "a".repeat(500)];
    for (const n of names) {
      const i = hueIndex(n);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(FOLDER_TOKENS.length);
    }
  });

  it("spreads a handful of real folder names over more than one hue", () => {
    const folders = ["characters", "concepts", "daily", "locations", "notes"];
    expect(new Set(folders.map((f) => hueIndex(f))).size).toBeGreaterThan(1);
  });

  it("hashes to an unsigned value, so the bucket index is never negative", () => {
    for (const n of ["x", "characters", "concepts", "ÿÿ"]) {
      expect(hashFolder(n)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("colour lookup", () => {
  const colours = [10, 20, 30, 40];

  it("indexes the palette it is given, not the token list length", () => {
    const picked = colourForFolder("characters", colours);
    expect(colours).toContain(picked);
  });

  it("is stable for a folder across calls", () => {
    expect(colourForFolder("daily", colours)).toBe(
      colourForFolder("daily", colours),
    );
  });

  it("does not divide by zero on an empty palette", () => {
    expect(colourForFolder("x", [])).toBe(0);
  });
});
