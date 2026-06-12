import { describe, expect, it } from "vitest";
import { buildFileTree, flattenTree } from "./fileTree";

const md = (path: string) => ({ path, type_id: "markdown" });

describe("buildFileTree", () => {
  it("nests files under folder segments", () => {
    const root = buildFileTree([
      md("projects/roadmap.md"),
      md("projects/backlog.md"),
      md("welcome.md"),
    ]);
    expect(root.files.map((f) => f.name)).toEqual(["welcome.md"]);
    expect(root.folders.map((f) => f.path)).toEqual(["projects"]);
    expect(root.folders[0]!.files.map((f) => f.name)).toEqual([
      "backlog.md",
      "roadmap.md",
    ]);
  });

  it("builds deep folder paths once and reuses them", () => {
    const root = buildFileTree([md("a/b/c/one.md"), md("a/b/two.md")]);
    expect(root.folders).toHaveLength(1);
    const a = root.folders[0]!;
    expect(a.path).toBe("a");
    const b = a.folders[0]!;
    expect(b.path).toBe("a/b");
    expect(b.files.map((f) => f.name)).toEqual(["two.md"]);
    expect(b.folders[0]!.path).toBe("a/b/c");
    expect(b.folders[0]!.files[0]!.path).toBe("a/b/c/one.md");
  });

  it("sorts folders and files case-insensitively, folders independent of files", () => {
    const root = buildFileTree([
      md("Zeta.md"),
      md("alpha.md"),
      md("Beta/x.md"),
      md("apple/y.md"),
    ]);
    expect(root.folders.map((f) => f.name)).toEqual(["apple", "Beta"]);
    expect(root.files.map((f) => f.name)).toEqual(["alpha.md", "Zeta.md"]);
  });

  it("ignores empty path segments", () => {
    const root = buildFileTree([md("dir//note.md")]);
    expect(root.folders[0]!.path).toBe("dir");
    expect(root.folders[0]!.files[0]!.name).toBe("note.md");
  });

  it("carries the file type id through", () => {
    const root = buildFileTree([{ path: "img.png", type_id: "image" }]);
    expect(root.files[0]!.typeId).toBe("image");
  });
});

describe("flattenTree", () => {
  const root = buildFileTree([
    md("projects/roadmap.md"),
    md("projects/deep/note.md"),
    md("welcome.md"),
  ]);

  it("emits folders before files, with depth and folders-first order", () => {
    const rows = flattenTree(root, new Set());
    expect(rows.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "projects", 0],
      ["folder", "projects/deep", 1],
      ["file", "projects/deep/note.md", 2],
      ["file", "projects/roadmap.md", 1],
      ["file", "welcome.md", 0],
    ]);
  });

  it("hides descendants of a collapsed folder but still emits the folder", () => {
    const rows = flattenTree(root, new Set(["projects"]));
    expect(rows.map((r) => r.path)).toEqual(["projects", "welcome.md"]);
    const projects = rows.find((r) => r.path === "projects");
    expect(projects).toMatchObject({ kind: "folder", collapsed: true });
  });

  it("collapsing a deep folder only hides its own subtree", () => {
    const rows = flattenTree(root, new Set(["projects/deep"]));
    expect(rows.map((r) => r.path)).toEqual([
      "projects",
      "projects/deep",
      "projects/roadmap.md",
      "welcome.md",
    ]);
  });
});
