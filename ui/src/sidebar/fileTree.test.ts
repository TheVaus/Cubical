import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  buildStableTreeRows,
  countFilesUnderFolder,
  flattenTree,
} from "./fileTree";

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

  it("sorts numeric name suffixes in natural order, not lexicographic", () => {
    const root = buildFileTree([
      md("fname-1.md"),
      md("fname-10.md"),
      md("fname-2.md"),
      md("fname-100.md"),
    ]);
    expect(root.files.map((f) => f.name)).toEqual([
      "fname-1.md",
      "fname-2.md",
      "fname-10.md",
      "fname-100.md",
    ]);
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

  it("materializes empty folders that hold no files", () => {
    const root = buildFileTree([md("welcome.md")], [
      "empty",
      "projects/archive",
    ]);
    expect(root.folders.map((f) => f.path)).toEqual(["empty", "projects"]);
    const projects = root.folders.find((f) => f.path === "projects")!;
    expect(projects.folders.map((f) => f.path)).toEqual(["projects/archive"]);
    expect(projects.folders[0]!.files).toHaveLength(0);
  });

  it("merges a tracked folder with files discovered under it", () => {
    const root = buildFileTree([md("projects/roadmap.md")], ["projects"]);
    expect(root.folders).toHaveLength(1);
    expect(root.folders[0]!.path).toBe("projects");
    expect(root.folders[0]!.files.map((f) => f.name)).toEqual(["roadmap.md"]);
  });

  it("flattens an empty tracked folder as a visible row", () => {
    const rows = flattenTree(buildFileTree([], ["notes"]), new Set());
    expect(rows).toEqual([
      { kind: "folder", path: "notes", name: "notes", depth: 0, collapsed: false },
    ]);
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

describe("buildStableTreeRows", () => {
  it("reuses every row's object reference when nothing changed", () => {
    const entries = [md("welcome.md"), md("projects/roadmap.md")];
    const first = buildStableTreeRows([], entries, [], new Set());
    const second = buildStableTreeRows(first, entries, [], new Set());

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("gives a fresh reference only to the row that actually changed", () => {
    const entries = [md("welcome.md"), md("projects/roadmap.md")];
    const first = buildStableTreeRows([], entries, [], new Set());
    const second = buildStableTreeRows(
      first,
      entries,
      [],
      new Set(["projects"]),
    );

    const folderBefore = first.find((r) => r.path === "projects")!;
    const folderAfter = second.find((r) => r.path === "projects")!;
    const fileBefore = first.find((r) => r.path === "welcome.md")!;
    const fileAfter = second.find((r) => r.path === "welcome.md")!;

    expect(folderAfter).not.toBe(folderBefore);
    expect(folderAfter.kind).toBe("folder");
    expect(folderAfter.kind === "folder" && folderAfter.collapsed).toBe(true);
    expect(fileAfter).toBe(fileBefore);
  });

  it("gives a fresh reference to a newly added file without touching others", () => {
    const entries = [md("welcome.md")];
    const first = buildStableTreeRows([], entries, [], new Set());
    const second = buildStableTreeRows(
      first,
      [...entries, md("second.md")],
      [],
      new Set(),
    );

    const welcomeBefore = first.find((r) => r.path === "welcome.md")!;
    const welcomeAfter = second.find((r) => r.path === "welcome.md")!;
    expect(welcomeAfter).toBe(welcomeBefore);
    expect(second.find((r) => r.path === "second.md")).toBeTruthy();
  });
});

describe("countFilesUnderFolder", () => {
  it("counts files directly under the folder", () => {
    const root = buildFileTree([md("projects/a.md"), md("projects/b.md")]);
    expect(countFilesUnderFolder(root, "projects")).toBe(2);
  });

  it("counts files nested in subfolders, regardless of collapse state", () => {
    // countFilesUnderFolder walks the nested tree, not the flattened
    // collapse-aware row list — a collapsed subfolder must not undercount.
    const root = buildFileTree([
      md("projects/a.md"),
      md("projects/deep/b.md"),
      md("projects/deep/deeper/c.md"),
    ]);
    expect(countFilesUnderFolder(root, "projects")).toBe(3);
  });

  it("returns 0 for a folder with no files", () => {
    const root = buildFileTree([], ["empty"]);
    expect(countFilesUnderFolder(root, "empty")).toBe(0);
  });

  it("returns 0 for an unknown folder path", () => {
    const root = buildFileTree([md("welcome.md")]);
    expect(countFilesUnderFolder(root, "nope")).toBe(0);
  });

  it("doesn't count files outside the folder", () => {
    const root = buildFileTree([
      md("projects/a.md"),
      md("other/b.md"),
      md("root.md"),
    ]);
    expect(countFilesUnderFolder(root, "projects")).toBe(1);
  });
});
