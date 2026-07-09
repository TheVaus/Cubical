import { describe, it, expect } from "vitest";
import {
  DEFAULT_BINDINGS,
  COMMAND_DEFAULTS,
  findDuplicateBindings,
  parseKeySpec,
  chordMatches,
  resolveGlobal,
  toCmBindings,
  resolveBindings,
  findConflict,
  specFromChord,
  formatChordForDisplay,
  type Command,
} from "./commands";

const cmd = (id: string, when?: () => boolean): Command =>
  when
    ? { id, title: id, run: () => {}, when }
    : { id, title: id, run: () => {} };

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

describe("COMMAND_DEFAULTS", () => {
  it("has a unique id for every command", () => {
    const ids = COMMAND_DEFAULTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the three v1 commands with their expected default keys", () => {
    const byId = new Map(COMMAND_DEFAULTS.map((c) => [c.id, c]));
    expect(byId.get("omnibar.toggle")?.defaultKey).toBe("Mod-k");
    expect(byId.get("editor.toggleRawSource")?.defaultKey).toBe("Mod-e");
    expect(byId.get("editor.copyBlockRef")?.defaultKey).toBe("Mod-Shift-b");
  });
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

describe("toCmBindings", () => {
  const binds = [
    { key: "Mod-k", command: "omnibar.toggle", scope: "global" as const },
    {
      key: "Mod-e",
      command: "editor.toggleRawSource",
      scope: "editor" as const,
    },
  ];

  it("emits one entry per editor-scope binding with an existing command", () => {
    let ran = 0;
    const cmds = {
      "editor.toggleRawSource": {
        ...cmd("editor.toggleRawSource"),
        run: () => {
          ran++;
        },
      },
    };
    const out = toCmBindings(binds, cmds);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("Mod-e");
    expect(out[0]?.run()).toBe(true);
    expect(ran).toBe(1);
  });

  it("run() returns false (falls through) when when() is false", () => {
    const cmds = {
      "editor.toggleRawSource": cmd("editor.toggleRawSource", () => false),
    };
    const out = toCmBindings(binds, cmds);
    expect(out[0]?.run()).toBe(false);
  });

  it("omits bindings whose command is missing", () => {
    expect(toCmBindings(binds, {})).toEqual([]);
  });
});

describe("resolveBindings", () => {
  it("returns the default binding table when there are no overrides", () => {
    expect(resolveBindings({})).toEqual(DEFAULT_BINDINGS);
  });

  it("overrides one command's key and leaves the rest at default", () => {
    const out = resolveBindings({ "omnibar.toggle": "Mod-Shift-p" });
    expect(out.find((b) => b.command === "omnibar.toggle")?.key).toBe(
      "Mod-Shift-p",
    );
    expect(
      out.find((b) => b.command === "editor.toggleRawSource")?.key,
    ).toBe("Mod-e");
  });

  it("ignores an override for a command id that doesn't exist", () => {
    expect(resolveBindings({ "no.such.command": "Mod-z" })).toEqual(
      DEFAULT_BINDINGS,
    );
  });

  it("falls back to the default key when an override is an empty string", () => {
    const out = resolveBindings({ "omnibar.toggle": "" });
    expect(out.find((b) => b.command === "omnibar.toggle")?.key).toBe(
      "Mod-k",
    );
  });
});

describe("findConflict", () => {
  const bindings = [
    { key: "Mod-k", command: "omnibar.toggle", scope: "global" as const },
    {
      key: "Mod-e",
      command: "editor.toggleRawSource",
      scope: "editor" as const,
    },
  ];

  it("returns the colliding command id within the same scope", () => {
    expect(
      findConflict("Mod-e", "editor", bindings, "editor.copyBlockRef"),
    ).toBe("editor.toggleRawSource");
  });

  it("does not flag a match in a different scope", () => {
    expect(
      findConflict("Mod-k", "editor", bindings, "editor.toggleRawSource"),
    ).toBeUndefined();
  });

  it("excludes the command being edited from its own conflict check", () => {
    expect(
      findConflict("Mod-e", "editor", bindings, "editor.toggleRawSource"),
    ).toBeUndefined();
  });

  it("returns undefined for a key nothing is bound to", () => {
    expect(
      findConflict("Mod-Shift-z", "editor", bindings, "editor.copyBlockRef"),
    ).toBeUndefined();
  });
});

describe("specFromChord", () => {
  it("builds a Mod-only spec", () => {
    expect(specFromChord({ mod: true, shift: false, alt: false, key: "k" })).toBe(
      "Mod-k",
    );
  });
  it("builds a Mod-Shift spec", () => {
    expect(
      specFromChord({ mod: true, shift: true, alt: false, key: "b" }),
    ).toBe("Mod-Shift-b");
  });
  it("builds an Alt-only spec", () => {
    expect(specFromChord({ mod: false, shift: false, alt: true, key: "j" })).toBe(
      "Alt-j",
    );
  });
});

describe("formatChordForDisplay", () => {
  it("renders a Mod-only chord", () => {
    expect(formatChordForDisplay("Mod-k")).toEqual(["⌘/Ctrl", "K"]);
  });
  it("renders a Mod-Shift chord and uppercases the key", () => {
    expect(formatChordForDisplay("Mod-Shift-b")).toEqual([
      "⌘/Ctrl",
      "⇧",
      "B",
    ]);
  });
});

describe("new bindable commands (#7)", () => {
  const ids = COMMAND_DEFAULTS.map((c) => c.id);
  it("registers the three new commands with Obsidian-matched defaults", () => {
    expect(COMMAND_DEFAULTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "editor.followWikilink", scope: "editor", defaultKey: "Alt-Enter" }),
        expect.objectContaining({ id: "view.toggleSidebar", scope: "global", defaultKey: "Mod-Shift-l" }),
        expect.objectContaining({ id: "file.new", scope: "global", defaultKey: "Mod-n" }),
      ]),
    );
  });
  it("introduces no default-binding conflicts", () => {
    expect(findDuplicateBindings(resolveBindings({}))).toEqual([]);
  });
  it("registers each new command id exactly once", () => {
    for (const id of ["editor.followWikilink", "view.toggleSidebar", "file.new"]) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });
});
