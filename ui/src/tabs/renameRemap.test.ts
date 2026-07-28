import { describe, expect, it } from "vitest";
import { reprefixNestedPath } from "../fileRename";
import { dropMissingTabs, emptyTabs, openTab, remapTabPaths } from "./tabModel";

const remapFor =
  (fromPath: string, target: string, isFolder: boolean) => (p: string) =>
    isFolder
      ? reprefixNestedPath(p, fromPath, target)
      : p === fromPath
        ? target
        : null;

describe("rename remapping", () => {
  it("follows a renamed file and moves the active id", () => {
    let s = openTab(emptyTabs, { kind: "file", path: "notes/A.md" });
    s = remapTabPaths(s, remapFor("notes/A.md", "notes/B.md", false));
    expect(s.tabs[0]!.view).toEqual({ kind: "file", path: "notes/B.md" });
    expect(s.activeId).toBe("file:notes/B.md");
  });

  it("follows every tab under a renamed folder", () => {
    let s = openTab(emptyTabs, { kind: "file", path: "old/A.md" });
    s = openTab(s, { kind: "file", path: "old/sub/B.md" });
    s = openTab(s, { kind: "file", path: "other/C.md" });
    s = remapTabPaths(s, remapFor("old", "new", true));
    expect(s.tabs.map((t) => t.view)).toEqual([
      { kind: "file", path: "new/A.md" },
      { kind: "file", path: "new/sub/B.md" },
      { kind: "file", path: "other/C.md" },
    ]);
  });

  it("leaves tabs outside the renamed folder untouched", () => {
    let s = openTab(emptyTabs, { kind: "file", path: "older/A.md" });
    s = remapTabPaths(s, remapFor("old", "new", true));
    expect(s.tabs[0]!.view).toEqual({ kind: "file", path: "older/A.md" });
  });

  it("closes a tab whose file was deleted externally", () => {
    let s = openTab(emptyTabs, { kind: "file", path: "A.md" });
    s = openTab(s, { kind: "file", path: "B.md" });
    s = dropMissingTabs(s, (p) => p !== "B.md");
    expect(s.tabs.map((t) => t.id)).toEqual(["file:A.md"]);
    expect(s.activeId).toBe("file:A.md");
  });
});
