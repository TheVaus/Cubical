import { describe, expect, it } from "vitest";

import {
  hasUnmodelableYaml,
  serializeFrontmatter,
  spliceFrontmatter,
} from "./serializeFrontmatter";
import { parseFrontmatterYaml, splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import { parseTypeComments, type PropertyType } from "./typeComments";

const ISO = "YYYY-MM-DD";

/** Serialize → split → parse, returning the re-parsed entries. */
function roundTrip(entries: FrontmatterEntry[]): FrontmatterEntry[] {
  const block = serializeFrontmatter(entries);
  const split = splitFrontmatter(block);
  if (split.yaml === null || split.span === null) {
    throw new Error("serialized block did not split back into frontmatter");
  }
  const fm = parseFrontmatterYaml(split.yaml, split.span);
  return fm ? fm.entries : [];
}

describe("serializeFrontmatter", () => {
  it("wraps output in --- fences ending with a newline", () => {
    const block = serializeFrontmatter([["title", "foo"]]);
    expect(block.startsWith("---\n")).toBe(true);
    expect(block.endsWith("---\n")).toBe(true);
  });

  it("emits an empty block for no entries", () => {
    expect(serializeFrontmatter([])).toBe("---\n---\n");
  });

  it("round-trips a string scalar", () => {
    expect(roundTrip([["title", "foo"]])).toEqual([["title", "foo"]]);
  });

  it("round-trips a number scalar", () => {
    expect(roundTrip([["count", 7]])).toEqual([["count", 7]]);
  });

  it("round-trips a boolean scalar", () => {
    expect(roundTrip([["archived", false]])).toEqual([["archived", false]]);
  });

  it("round-trips a date-shaped string as a plain scalar", () => {
    expect(roundTrip([["created", "2026-05-13"]])).toEqual([
      ["created", "2026-05-13"],
    ]);
  });

  it("round-trips a string list", () => {
    expect(roundTrip([["tags", ["a", "b"]]])).toEqual([["tags", ["a", "b"]]]);
  });

  it("round-trips a nested mapping", () => {
    expect(roundTrip([["nested", { x: 1 }]])).toEqual([["nested", { x: 1 }]]);
  });

  it("preserves key order", () => {
    const entries: FrontmatterEntry[] = [
      ["z", "1"],
      ["a", "2"],
      ["m", "3"],
    ];
    expect(roundTrip(entries)).toEqual(entries);
  });

  it("round-trips the full six-row demo document losslessly", () => {
    const entries: FrontmatterEntry[] = [
      ["title", "foo"],
      ["tags", ["a", "b"]],
      ["created", "2026-05-13"],
      ["archived", false],
      ["count", 7],
      ["nested", { x: 1 }],
    ];
    expect(roundTrip(entries)).toEqual(entries);
  });
});

describe("parse → edit → serialize → re-parse round-trip", () => {
  it("survives an in-place edit losslessly", () => {
    const source =
      "---\ntitle: foo\ntags:\n  - a\n  - b\ncount: 7\n---\n\nbody\n";
    const split = splitFrontmatter(source);
    if (split.yaml === null || split.span === null) {
      throw new Error("fixture has no frontmatter");
    }
    const parsed = parseFrontmatterYaml(split.yaml, split.span);
    if (!parsed) throw new Error("fixture failed to parse");

    // Edit: change `title`, leave the rest untouched.
    const edited = parsed.entries.map(
      ([k, v]): FrontmatterEntry => (k === "title" ? [k, "bar"] : [k, v]),
    );

    const reSplit = splitFrontmatter(serializeFrontmatter(edited));
    if (reSplit.yaml === null || reSplit.span === null) {
      throw new Error("re-serialized block did not split");
    }
    const reParsed = parseFrontmatterYaml(reSplit.yaml, reSplit.span);
    expect(reParsed?.entries).toEqual([
      ["title", "bar"],
      ["tags", ["a", "b"]],
      ["count", 7],
    ]);
  });
});

describe("spliceFrontmatter", () => {
  it("replaces an existing frontmatter block, keeping the body", () => {
    const source = "---\ntitle: old\n---\n\nbody text\n";
    const block = serializeFrontmatter([["title", "new"]]);
    const result = spliceFrontmatter(source, block);
    expect(result).toBe("---\ntitle: new\n---\n\nbody text\n");
  });

  it("inserts a block at offset 0 for a frontmatter-less file", () => {
    const source = "just body text\n";
    const block = serializeFrontmatter([["title", "new"]]);
    const result = spliceFrontmatter(source, block);
    expect(result).toBe("---\ntitle: new\n---\njust body text\n");
  });

  it("inserts into an empty file", () => {
    const block = serializeFrontmatter([["title", "new"]]);
    expect(spliceFrontmatter("", block)).toBe("---\ntitle: new\n---\n");
  });
});

describe("hasUnmodelableYaml", () => {
  it("returns false for plain modelable frontmatter", () => {
    expect(hasUnmodelableYaml("title: foo\ntags: [a, b]\n")).toBe(false);
  });

  it("returns true when a comment is present", () => {
    expect(hasUnmodelableYaml("title: foo # a comment\n")).toBe(true);
  });

  it("returns true when a leading comment is present", () => {
    expect(hasUnmodelableYaml("# header comment\ntitle: foo\n")).toBe(true);
  });

  it("returns true when an anchor/alias is present", () => {
    expect(hasUnmodelableYaml("a: &x foo\nb: *x\n")).toBe(true);
  });

  it("returns true for unparseable YAML", () => {
    expect(hasUnmodelableYaml("title: : :\n  bad\n- mix\n")).toBe(true);
  });

  it("returns false for empty YAML", () => {
    expect(hasUnmodelableYaml("")).toBe(false);
  });
});

describe("serializeFrontmatter with type comments", () => {
  it("writes a trailing type comment for a scalar value", () => {
    const out = serializeFrontmatter(
      [["price", 9.99]],
      new Map<string, PropertyType>([
        ["price", { kind: "currency", currency: "nis" }],
      ]),
      ISO,
    );
    expect(out).toContain("# type:float/currency/nis");
    expect(out).toContain("price: 9.99");
  });

  it("omits the currency code when it matches the default", () => {
    const out = serializeFrontmatter(
      [["price", 9.99]],
      new Map<string, PropertyType>([
        ["price", { kind: "currency", currency: "usd" }],
      ]),
      ISO,
      "usd",
    );
    expect(out).toContain("# type:float/currency");
    expect(out).not.toContain("# type:float/currency/");
  });

  it("omits the param for a default-format date, writes it otherwise", () => {
    const def = serializeFrontmatter(
      [["a", "2026-06-17"]],
      new Map<string, PropertyType>([["a", { kind: "date", format: ISO }]]),
      ISO,
    );
    expect(def).toContain("# type:date");
    expect(def).not.toContain("# type:date:");

    const custom = serializeFrontmatter(
      [["a", "17-06-26"]],
      new Map<string, PropertyType>([
        ["a", { kind: "date", format: "DD-MM-YY" }],
      ]),
      ISO,
    );
    expect(custom).toContain("# type:date:DD-MM-YY");
  });

  it("writes the comment on the key line for a block-list value", () => {
    const out = serializeFrontmatter(
      [["people", ["Ann"]]],
      new Map<string, PropertyType>([["people", { kind: "list-of-strings" }]]),
      ISO,
    );
    const firstLine = out.split("\n").find((l) => l.startsWith("people:"))!;
    expect(firstLine).toContain("# type:list");
  });

  it("does not annotate raw kinds", () => {
    const out = serializeFrontmatter(
      [["n", 3]],
      new Map<string, PropertyType>([["n", { kind: "raw" }]]),
      ISO,
    );
    expect(out).not.toContain("# type:");
  });

  it("round-trips: serialize then parseTypeComments recovers the types", () => {
    const types = new Map<string, PropertyType>([
      ["price", { kind: "currency", currency: "eur" }],
      ["status", { kind: "enum", values: ["alive", "dead"] }],
      ["d", { kind: "date", format: "DD-MM-YY" }],
      ["topics", { kind: "list-of-strings" }],
    ]);
    const out = serializeFrontmatter(
      [
        ["price", 9.99],
        ["status", "alive"],
        ["d", "17-06-26"],
        ["topics", ["#draft"]],
      ],
      types,
      ISO,
    );
    const body = out.replace(/^---\n/, "").replace(/---\n$/, "");
    expect(parseTypeComments(body)).toEqual(types);
  });
});

describe("hasUnmodelableYaml with type comments", () => {
  it("allows recognized type comments incl. dated and block-list", () => {
    expect(hasUnmodelableYaml("price: 9.99 # type:float/currency/usd\n")).toBe(
      false,
    );
    expect(hasUnmodelableYaml("d: 17-06-26 # type:date:DD-MM-YY\n")).toBe(false);
    expect(hasUnmodelableYaml("people: # type:list\n  - Ann\n")).toBe(false);
  });

  it("still flags foreign comments and anchors", () => {
    expect(hasUnmodelableYaml("a: 1 # just a note\n")).toBe(true);
    expect(hasUnmodelableYaml("a: &x 1\nb: *x\n")).toBe(true);
    expect(hasUnmodelableYaml("a: 1 # type:bogus\n")).toBe(true);
  });
});
