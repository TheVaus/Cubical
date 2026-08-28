import { describe, expect, it, vi } from "vitest";

import { buildContextMenuItems } from "./contextMenuItems";

const noop = () => ({
  newFile: vi.fn(),
  newFolder: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  renameTag: vi.fn(),
});

const ids = (kind: "file" | "folder" | "empty" | "tag", path = "notes") =>
  buildContextMenuItems({ kind, path }, noop()).map((i) => i.id);

describe("buildContextMenuItems", () => {
  it("offers creation but not rename or delete on empty space", () => {
    expect(ids("empty", "")).toEqual(["new-file", "new-folder"]);
  });

  it("offers everything on a folder, which can both contain and be renamed", () => {
    expect(ids("folder")).toEqual([
      "new-file",
      "new-folder",
      "rename",
      "delete",
    ]);
  });

  it("omits creation on a file, which cannot contain anything", () => {
    expect(ids("file", "notes/a.md")).toEqual(["rename", "delete"]);
  });

  it("offers only a tag rename on a tag, which owns no files of its own", () => {
    expect(ids("tag", "project/alpha")).toEqual(["rename-tag"]);
  });

  it("routes a tag rename to the tag handler with the full tag path", () => {
    const on = noop();
    const items = buildContextMenuItems(
      { kind: "tag", path: "project/alpha" },
      on,
    );
    items[0]!.onSelect();
    expect(on.renameTag).toHaveBeenCalledWith("project/alpha");
    expect(on.rename).not.toHaveBeenCalled();
  });

  it("marks only delete as dangerous", () => {
    const items = buildContextMenuItems(
      { kind: "folder", path: "notes" },
      noop(),
    );
    expect(items.filter((i) => i.danger === true).map((i) => i.id)).toEqual([
      "delete",
    ]);
  });

  it("creates inside the folder that was right-clicked", () => {
    const on = noop();
    const items = buildContextMenuItems({ kind: "folder", path: "notes" }, on);
    items.find((i) => i.id === "new-file")!.onSelect();
    items.find((i) => i.id === "new-folder")!.onSelect();
    expect(on.newFile).toHaveBeenCalledWith("notes");
    expect(on.newFolder).toHaveBeenCalledWith("notes");
  });

  it("deletes a folder as a folder, so the caller can count what it holds", () => {
    const on = noop();
    buildContextMenuItems({ kind: "folder", path: "notes" }, on)
      .find((i) => i.id === "delete")!
      .onSelect();
    expect(on.remove).toHaveBeenCalledWith("notes", "folder");
  });

  it("deletes a file as a file", () => {
    const on = noop();
    buildContextMenuItems({ kind: "file", path: "notes/a.md" }, on)
      .find((i) => i.id === "delete")!
      .onSelect();
    expect(on.remove).toHaveBeenCalledWith("notes/a.md", "file");
  });

  it("renames the path that was right-clicked", () => {
    const on = noop();
    buildContextMenuItems({ kind: "file", path: "notes/a.md" }, on)
      .find((i) => i.id === "rename")!
      .onSelect();
    expect(on.rename).toHaveBeenCalledWith("notes/a.md");
  });
});
