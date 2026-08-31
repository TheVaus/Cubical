import { describe, it, expect } from "vitest";

import {
  basename,
  isValidNoteName,
  noteNameError,
  noteTitle,
  parentPrefix,
  stripMarkdownExtension,
} from "./noteName";

const CASES: ReadonlyArray<{
  path: string;
  title: string;
  stripped: string;
  base: string;
  parent: string;
}> = [
  {
    path: "note.md",
    title: "note",
    stripped: "note",
    base: "note.md",
    parent: "",
  },
  {
    path: "folder/note.md",
    title: "note",
    stripped: "folder/note",
    base: "note.md",
    parent: "folder/",
  },
  {
    path: "notes.txt",
    title: "notes.txt",
    stripped: "notes.txt",
    base: "notes.txt",
    parent: "",
  },
  { path: "a.b.md", title: "a.b", stripped: "a.b", base: "a.b.md", parent: "" },
  {
    path: "no-extension",
    title: "no-extension",
    stripped: "no-extension",
    base: "no-extension",
    parent: "",
  },
  {
    path: ".hidden",
    title: ".hidden",
    stripped: ".hidden",
    base: ".hidden",
    parent: "",
  },
  {
    path: "assets/diagram.png",
    title: "diagram.png",
    stripped: "assets/diagram.png",
    base: "diagram.png",
    parent: "assets/",
  },
  { path: "notes/", title: "", stripped: "notes/", base: "", parent: "notes/" },
  { path: "", title: "", stripped: "", base: "", parent: "" },
];

describe("note name derivation", () => {
  it.each(CASES)(
    "derives every form of $path",
    ({ path, title, stripped, base, parent }) => {
      expect(noteTitle(path)).toBe(title);
      expect(stripMarkdownExtension(path)).toBe(stripped);
      expect(basename(path)).toBe(base);
      expect(parentPrefix(path)).toBe(parent);
    },
  );

  it("removes only a trailing .md", () => {
    expect(noteTitle("note.md.txt")).toBe("note.md.txt");
    expect(noteTitle("note.MD")).toBe("note.MD");
    expect(noteTitle("md")).toBe("md");
    expect(noteTitle(".md")).toBe("");
  });
});

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
