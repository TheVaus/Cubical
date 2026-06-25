import { describe, it, expect } from "vitest";
import { DEFAULT_BINDINGS, findDuplicateBindings } from "./commands";

describe("findDuplicateBindings", () => {
  it("returns [] when every (scope,key) is unique", () => {
    expect(
      findDuplicateBindings([
        { key: "Mod-k", command: "omnibar.toggle", scope: "global" },
        { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" },
      ]),
    ).toEqual([]);
  });

  it("flags a (scope,key) claimed twice", () => {
    expect(
      findDuplicateBindings([
        { key: "Mod-k", command: "a", scope: "global" },
        { key: "Mod-k", command: "b", scope: "global" },
      ]),
    ).toEqual(["global:Mod-k"]);
  });

  it("treats the same key in different scopes as distinct", () => {
    expect(
      findDuplicateBindings([
        { key: "Mod-k", command: "a", scope: "global" },
        { key: "Mod-k", command: "b", scope: "editor" },
      ]),
    ).toEqual([]);
  });

  it("ships a default binding table with no duplicates", () => {
    expect(findDuplicateBindings(DEFAULT_BINDINGS)).toEqual([]);
  });
});
