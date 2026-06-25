import { describe, it, expect } from "vitest";
import {
  DEFAULT_BINDINGS,
  findDuplicateBindings,
  parseKeySpec,
  chordMatches,
  resolveGlobal,
  type Command,
} from "./commands";

const cmd = (id: string, when?: () => boolean): Command => ({
  id,
  title: id,
  run: () => {},
  when,
});

const ev = (
  o: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    key: string;
  }>,
) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: "",
  ...o,
});

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

describe("parseKeySpec", () => {
  it("parses modifiers and lower-cases the key", () => {
    expect(parseKeySpec("Mod-Shift-B")).toEqual({
      mod: true,
      shift: true,
      alt: false,
      key: "b",
    });
  });
  it("parses a bare key", () => {
    expect(parseKeySpec("k")).toEqual({
      mod: false,
      shift: false,
      alt: false,
      key: "k",
    });
  });
});

describe("chordMatches", () => {
  it("matches Mod-k against metaKey", () => {
    expect(chordMatches("Mod-k", ev({ metaKey: true, key: "k" }))).toBe(true);
  });
  it("matches Mod-k against ctrlKey", () => {
    expect(chordMatches("Mod-k", ev({ ctrlKey: true, key: "k" }))).toBe(true);
  });
  it("is case-insensitive on the event key", () => {
    expect(chordMatches("Mod-k", ev({ metaKey: true, key: "K" }))).toBe(true);
  });
  it("rejects when an extra modifier is held", () => {
    expect(
      chordMatches("Mod-k", ev({ metaKey: true, shiftKey: true, key: "k" })),
    ).toBe(false);
  });
  it("rejects a bare key when no modifier required and one is held", () => {
    expect(chordMatches("k", ev({ metaKey: true, key: "k" }))).toBe(false);
  });
  it("matches Mod-Shift-b", () => {
    expect(
      chordMatches(
        "Mod-Shift-b",
        ev({ metaKey: true, shiftKey: true, key: "b" }),
      ),
    ).toBe(true);
  });
});

describe("resolveGlobal", () => {
  const binds = [
    { key: "Mod-k", command: "omnibar.toggle", scope: "global" as const },
    {
      key: "Mod-e",
      command: "editor.toggleRawSource",
      scope: "editor" as const,
    },
  ];

  it("returns the matching global command", () => {
    const cmds = { "omnibar.toggle": cmd("omnibar.toggle") };
    const r = resolveGlobal(binds, cmds, ev({ metaKey: true, key: "k" }));
    expect(r?.id).toBe("omnibar.toggle");
  });

  it("ignores editor-scope bindings", () => {
    const cmds = { "editor.toggleRawSource": cmd("editor.toggleRawSource") };
    expect(
      resolveGlobal(binds, cmds, ev({ metaKey: true, key: "e" })),
    ).toBeUndefined();
  });

  it("skips a command whose when() is false", () => {
    const cmds = { "omnibar.toggle": cmd("omnibar.toggle", () => false) };
    expect(
      resolveGlobal(binds, cmds, ev({ metaKey: true, key: "k" })),
    ).toBeUndefined();
  });

  it("returns undefined when no binding matches", () => {
    const cmds = { "omnibar.toggle": cmd("omnibar.toggle") };
    expect(resolveGlobal(binds, cmds, ev({ key: "x" }))).toBeUndefined();
  });
});
