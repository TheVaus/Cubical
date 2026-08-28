import { describe, expect, it } from "vitest";
import {
  UNTAGGED_ID,
  buildStableTagRows,
  buildTagTree,
  flattenTagTree,
  parentTagOf,
  type TagAssignment,
  type TagFlatRow,
} from "./tagTree";

const md = (path: string) => ({ path, type_id: "markdown" });
const at = (tag_path: string, file_path: string): TagAssignment => ({
  tag_path,
  file_path,
});
const none = new Set<string>();

describe("buildTagTree", () => {
  it("nests tag segments as folders", () => {
    const root = buildTagTree(
      [at("project/alpha", "notes/one.md")],
      [md("notes/one.md")],
    );
    const project = root.folders.find((f) => f.path === "project")!;
    expect(project.files).toEqual([]);
    const alpha = project.folders[0]!;
    expect(alpha.path).toBe("project/alpha");
    expect(alpha.files.map((f) => f.path)).toEqual(["notes/one.md"]);
  });

  it("places a file only in its deepest tag, not in ancestor tags", () => {
    const root = buildTagTree(
      [at("project/alpha", "notes/one.md")],
      [md("notes/one.md")],
    );
    const project = root.folders.find((f) => f.path === "project")!;
    expect(project.files).toEqual([]);
  });

  it("lists a file under every tag it carries", () => {
    const root = buildTagTree(
      [at("work", "notes/one.md"), at("urgent", "notes/one.md")],
      [md("notes/one.md")],
    );
    const work = root.folders.find((f) => f.path === "work")!;
    const urgent = root.folders.find((f) => f.path === "urgent")!;
    expect(work.files.map((f) => f.path)).toEqual(["notes/one.md"]);
    expect(urgent.files.map((f) => f.path)).toEqual(["notes/one.md"]);
  });

  it("collects files carrying no tag into the untagged bucket", () => {
    const root = buildTagTree(
      [at("work", "notes/one.md")],
      [md("notes/one.md"), md("notes/two.md"), md("img.png")],
    );
    const untagged = root.folders.find((f) => f.path === UNTAGGED_ID)!;
    expect(untagged.files.map((f) => f.path)).toEqual([
      "img.png",
      "notes/two.md",
    ]);
  });

  it("pins the untagged bucket last, after every real tag", () => {
    const root = buildTagTree(
      [at("zebra", "notes/one.md")],
      [md("notes/one.md"), md("notes/two.md")],
    );
    expect(root.folders.map((f) => f.path)).toEqual(["zebra", UNTAGGED_ID]);
  });

  it("omits the untagged bucket entirely when every file carries a tag", () => {
    const root = buildTagTree(
      [at("work", "notes/one.md")],
      [md("notes/one.md")],
    );
    expect(root.folders.map((f) => f.path)).toEqual(["work"]);
  });

  it("drops assignments whose file is no longer in the vault", () => {
    const root = buildTagTree(
      [at("work", "deleted.md"), at("work", "notes/one.md")],
      [md("notes/one.md")],
    );
    const work = root.folders.find((f) => f.path === "work")!;
    expect(work.files.map((f) => f.path)).toEqual(["notes/one.md"]);
  });

  it("keeps a tag whose only files are gone, so its subtree survives", () => {
    const root = buildTagTree([at("work", "deleted.md")], []);
    expect(root.folders.map((f) => f.path)).toEqual(["work"]);
    expect(root.folders[0]!.files).toEqual([]);
  });

  it("dedupes a file assigned the same tag twice", () => {
    const root = buildTagTree(
      [at("work", "notes/one.md"), at("work", "notes/one.md")],
      [md("notes/one.md")],
    );
    expect(root.folders[0]!.files.map((f) => f.path)).toEqual(["notes/one.md"]);
  });

  it("sorts tags and files case-insensitively", () => {
    const root = buildTagTree(
      [at("Zeta", "b.md"), at("alpha", "a.md"), at("alpha", "A2.md")],
      [md("a.md"), md("A2.md"), md("b.md")],
    );
    expect(root.folders.map((f) => f.name)).toEqual(["alpha", "Zeta"]);
    expect(root.folders[0]!.files.map((f) => f.name)).toEqual([
      "a.md",
      "A2.md",
    ]);
  });

  it("carries the file type through so rows can render an icon", () => {
    const root = buildTagTree(
      [at("work", "img.png")],
      [{ path: "img.png", type_id: "image" }],
    );
    expect(root.folders[0]!.files[0]!.typeId).toBe("image");
  });
});

describe("flattenTagTree", () => {
  it("emits a tag row before the rows nested under it", () => {
    const rows = flattenTagTree(
      buildTagTree([at("project/alpha", "one.md")], [md("one.md")]),
      none,
    );
    expect(rows.map((r) => [r.kind, r.id])).toEqual([
      ["tag", "project"],
      ["tag", "project/alpha"],
      ["file", "project/alpha\none.md"],
    ]);
  });

  it("hides descendants of a collapsed tag", () => {
    const rows = flattenTagTree(
      buildTagTree([at("project/alpha", "one.md")], [md("one.md")]),
      new Set(["project"]),
    );
    expect(rows.map((r) => r.id)).toEqual(["project"]);
    expect(rows[0]!.kind === "tag" && rows[0]!.collapsed).toBe(true);
  });

  it("gives the same file distinct row ids under each of its tags", () => {
    const rows = flattenTagTree(
      buildTagTree(
        [at("work", "one.md"), at("urgent", "one.md")],
        [md("one.md")],
      ),
      none,
    );
    const fileRows = rows.filter((r) => r.kind === "file");
    expect(fileRows).toHaveLength(2);
    expect(new Set(fileRows.map((r) => r.id)).size).toBe(2);
    expect(
      fileRows.every((r) => r.kind === "file" && r.path === "one.md"),
    ).toBe(true);
  });

  it("indents nested tags and their files by depth", () => {
    const rows = flattenTagTree(
      buildTagTree([at("a/b", "one.md")], [md("one.md")]),
      none,
    );
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("marks the untagged bucket so the UI can refuse to rename it", () => {
    const rows = flattenTagTree(buildTagTree([], [md("one.md")]), none);
    const bucket = rows[0]!;
    expect(bucket.kind === "tag" && bucket.renamable).toBe(false);
  });

  it("marks real tags as renamable", () => {
    const rows = flattenTagTree(
      buildTagTree([at("work", "one.md")], [md("one.md")]),
      none,
    );
    expect(rows[0]!.kind === "tag" && rows[0]!.renamable).toBe(true);
  });

  it("names a tag row by its last segment but identifies it by full path", () => {
    const rows = flattenTagTree(
      buildTagTree([at("project/alpha", "one.md")], [md("one.md")]),
      none,
    );
    const alpha = rows.find((r) => r.id === "project/alpha")!;
    expect(alpha.name).toBe("alpha");
  });
});

describe("buildStableTagRows", () => {
  const assignments = [at("work", "one.md")];
  const files = [md("one.md")];

  it("reuses row objects that did not change", () => {
    const first = buildStableTagRows([], assignments, files, none);
    const second = buildStableTagRows(first, assignments, files, none);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("replaces a row whose collapsed state changed", () => {
    const first = buildStableTagRows([], assignments, files, none);
    const second = buildStableTagRows(
      first,
      assignments,
      files,
      new Set(["work"]),
    );
    expect(second[0]).not.toBe(first[0]);
  });

  it("keeps one tag's rows identical when a different tag gains a file", () => {
    const first = buildStableTagRows(
      [],
      [at("work", "one.md"), at("home", "two.md")],
      [md("one.md"), md("two.md")],
      none,
    );
    const second = buildStableTagRows(
      first,
      [at("work", "one.md"), at("home", "two.md"), at("home", "three.md")],
      [md("one.md"), md("two.md"), md("three.md")],
      none,
    );
    const workRow = (rows: TagFlatRow[]) => rows.find((r) => r.id === "work")!;
    expect(workRow(second)).toBe(workRow(first));
  });
});

describe("parentTagOf", () => {
  it("returns the parent path of a nested tag", () => {
    expect(parentTagOf("project/alpha/beta")).toBe("project/alpha");
  });

  it("returns null for a top-level tag", () => {
    expect(parentTagOf("project")).toBe(null);
  });
});
