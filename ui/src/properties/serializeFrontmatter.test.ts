import { describe, expect, it } from "vitest";

import {
  hasUnmodelableYaml,
  planPropertyEdit,
  type PropertyEdit,
  serializeFrontmatter,
  spliceFrontmatter,
} from "./serializeFrontmatter";
import { parseFrontmatterYaml, splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import { parseTypeComments, type PropertyType } from "./typeComments";

const ISO = "YYYY-MM-DD";

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

  it("treats a trailing comment as modelable (it is preserved, not flagged)", () => {
    expect(hasUnmodelableYaml("title: foo # a comment\n")).toBe(false);
  });

  it("treats a leading comment as modelable", () => {
    expect(hasUnmodelableYaml("# header comment\ntitle: foo\n")).toBe(false);
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

  it("returns true for a layout an edit cannot be placed in", () => {
    expect(hasUnmodelableYaml("{title: foo, n: 1}\n")).toBe(true);
    expect(hasUnmodelableYaml("? title\n: foo\n")).toBe(true);
  });
});

describe("serializeFrontmatter preserves foreign content (in-place edit)", () => {
  it("keeps a trailing comment on an unchanged key when another value changes", () => {
    const existing = "title: Hi # keep me\ncount: 1\n";
    const out = serializeFrontmatter(
      [
        ["title", "Hi"],
        ["count", 2],
      ],
      undefined,
      "usd",
      existing,
    );
    expect(out).toContain("# keep me");
    expect(out).toContain("count: 2");
  });

  it("keeps a standalone comment line above a key even when its value changes", () => {
    const existing = "# section\ntitle: Hi\n";
    const out = serializeFrontmatter([["title", "Bye"]], undefined, "usd", existing);
    expect(out).toContain("# section");
    expect(out).toContain("title: Bye");
  });

  it("keeps comments on surviving keys when a key is deleted", () => {
    const existing = "a: 1 # note a\nb: 2\n";
    const out = serializeFrontmatter([["a", 1]], undefined, "usd", existing);
    expect(out).toContain("# note a");
    expect(out).not.toMatch(/^b:/m);
  });

  it("keeps existing comments when a new key is added", () => {
    const existing = "a: 1 # note a\n";
    const out = serializeFrontmatter(
      [
        ["a", 1],
        ["b", 2],
      ],
      undefined,
      "usd",
      existing,
    );
    expect(out).toContain("# note a");
    expect(out).toContain("b: 2");
  });

  it("keeps a comment with its key when keys are reordered", () => {
    const existing = "a: 1 # note a\nb: 2\n";
    const out = serializeFrontmatter(
      [
        ["b", 2],
        ["a", 1],
      ],
      undefined,
      "usd",
      existing,
    );
    const aLine = out.split("\n").find((l) => l.startsWith("a:"))!;
    expect(aLine).toContain("# note a");
  });

  it("applies a type comment while preserving a foreign comment on another key", () => {
    const existing = "title: Hi # keep\nprice: 9.99\n";
    const out = serializeFrontmatter(
      [
        ["title", "Hi"],
        ["price", 9.99],
      ],
      new Map<string, PropertyType>([
        ["price", { kind: "currency", currency: "nis" }],
      ]),
      "usd",
      existing,
    );
    expect(out).toContain("# keep");
    expect(out).toContain("# type:float/currency/nis");
  });

  it("falls back to a fresh build when there is no existing block", () => {
    const out = serializeFrontmatter([["a", 1]], undefined, "usd");
    expect(out).toBe("---\na: 1\n---\n");
  });
});

describe("serializeFrontmatter with type comments", () => {
  it("writes a trailing type comment for a scalar value", () => {
    const out = serializeFrontmatter(
      [["price", 9.99]],
      new Map<string, PropertyType>([
        ["price", { kind: "currency", currency: "nis" }],
      ]),
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
      "usd",
    );
    expect(out).toContain("# type:float/currency");
    expect(out).not.toContain("# type:float/currency/");
  });

  it("always writes the date format inline", () => {
    const iso = serializeFrontmatter(
      [["a", "2026-06-17"]],
      new Map<string, PropertyType>([["a", { kind: "date", format: ISO }]]),
    );
    expect(iso).toContain("# type:date:YYYY-MM-DD");

    const custom = serializeFrontmatter(
      [["a", "17-06-26"]],
      new Map<string, PropertyType>([
        ["a", { kind: "date", format: "DD-MM-YY" }],
      ]),
    );
    expect(custom).toContain("# type:date:DD-MM-YY");
  });

  it("writes the comment on the key line for a block-list value", () => {
    const out = serializeFrontmatter(
      [["people", ["Ann"]]],
      new Map<string, PropertyType>([["people", { kind: "list-of-strings" }]]),
    );
    const firstLine = out.split("\n").find((l) => l.startsWith("people:"))!;
    expect(firstLine).toContain("# type:list");
  });

  it("does not annotate raw kinds", () => {
    const out = serializeFrontmatter(
      [["n", 3]],
      new Map<string, PropertyType>([["n", { kind: "raw" }]]),
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
    );
    const body = out.replace(/^---\n/, "").replace(/---\n$/, "");
    expect(parseTypeComments(body)).toEqual(types);
  });
});

describe("hasUnmodelableYaml — comments allowed, anchors/aliases not", () => {
  it("allows comments of every shape (type hints, notes, unknown tokens)", () => {
    expect(hasUnmodelableYaml("price: 9.99 # type:float/currency/usd\n")).toBe(
      false,
    );
    expect(hasUnmodelableYaml("d: 17-06-26 # type:date:DD-MM-YY\n")).toBe(false);
    expect(hasUnmodelableYaml("people: # type:list\n  - Ann\n")).toBe(false);
    expect(hasUnmodelableYaml("a: 1 # just a note\n")).toBe(false);
    expect(hasUnmodelableYaml("a: 1 # type:bogus\n")).toBe(false);
  });

  it("still flags anchors and aliases", () => {
    expect(hasUnmodelableYaml("a: &x 1\nb: *x\n")).toBe(true);
    expect(hasUnmodelableYaml("a: &anchor 1\n")).toBe(true);
  });
});

const LONG = "word ".repeat(24).trim();
const UNTOUCHED = [
  "big: 12345678901234567890",
  `long: ${LONG}`,
  "list:",
  "- a",
  "- b",
  "hex: 0x1F",
  "sci: 1e3",
  "",
].join("\n");

describe("serializeFrontmatter leaves untouched pairs byte-identical", () => {
  it("keeps big ints, long scalars, list indent and number spelling when another key changes", () => {
    const existing = `title: Hi\n${UNTOUCHED}`;
    const out = serializeFrontmatter(
      [
        ["title", "Bye"],
        ["big", 12345678901234567890],
        ["long", LONG],
        ["list", ["a", "b"]],
        ["hex", 31],
        ["sci", 1000],
      ],
      undefined,
      "usd",
      existing,
    );
    expect(out).toBe(`---\ntitle: Bye\n${UNTOUCHED}---\n`);
  });

  it("does not rewrite type comments of keys whose type is unchanged", () => {
    const existing = "a: 1 #type:int\nb: x\n";
    const out = serializeFrontmatter(
      [
        ["a", 1],
        ["b", "y"],
      ],
      new Map<string, PropertyType>([["a", { kind: "int" }]]),
      "usd",
      existing,
    );
    expect(out).toBe("---\na: 1 #type:int\nb: y\n---\n");
  });

  it("does not fold a long value it writes", () => {
    const out = serializeFrontmatter([["long", LONG]], undefined, "usd", "long: x\n");
    expect(out).toBe(`---\nlong: ${LONG}\n---\n`);
  });

  it("writes a changed list in the file's own sequence indentation", () => {
    const out = serializeFrontmatter(
      [
        ["list", ["a"]],
        ["tags", ["x", "y"]],
      ],
      undefined,
      "usd",
      "list:\n- a\ntags:\n- x\n",
    );
    expect(out).toBe("---\nlist:\n- a\ntags:\n- x\n- y\n---\n");
  });
});

function applyPlan(source: string, edit: PropertyEdit): string {
  const plan = planPropertyEdit(source, edit, "usd");
  if (!plan) return source;
  return source.slice(0, plan.from) + plan.text + source.slice(plan.to);
}

describe("planPropertyEdit", () => {
  const source = `---\ntitle: Hi # keep\n${UNTOUCHED}---\n\nbody\n`;

  it("changes only the edited pair", () => {
    expect(applyPlan(source, { op: "set", key: "title", value: "Bye" })).toBe(
      `---\ntitle: Bye # keep\n${UNTOUCHED}---\n\nbody\n`,
    );
  });

  it("returns a range confined to the edited pair", () => {
    const plan = planPropertyEdit(source, { op: "set", key: "title", value: "Bye" }, "usd");
    expect(plan).toEqual({ from: 11, to: 13, text: "Bye" });
  });

  it("treats a precision-lossy number equal to the big int it came from as no change", () => {
    expect(
      planPropertyEdit(source, { op: "set", key: "big", value: 12345678901234567890 }, "usd"),
    ).toBeNull();
  });

  it("builds from the live source, so a prior edit to another key survives", () => {
    const live = "---\nx: edited\ndone: false\n---\n";
    expect(applyPlan(live, { op: "set", key: "done", value: true })).toBe(
      "---\nx: edited\ndone: true\n---\n",
    );
  });

  it("keeps an existing type comment when only the value changes", () => {
    const live = "---\nn: 1 # type:int\n---\n";
    expect(applyPlan(live, { op: "set", key: "n", value: 2 })).toBe(
      "---\nn: 2 # type:int\n---\n",
    );
  });

  it("keeps a block list's key-line type comment when its items change", () => {
    const live = "---\npeople: # type:list\n- Ann\nz: 1\n---\n";
    expect(
      applyPlan(live, { op: "set", key: "people", value: ["Ann", "Bob"] }),
    ).toBe("---\npeople: # type:list\n- Ann\n- Bob\nz: 1\n---\n");
  });

  it("sets and clears a type annotation on just that key", () => {
    const live = "---\na: 1 # type:int\nn: 1\n---\n";
    const typed = applyPlan(live, {
      op: "set",
      key: "n",
      value: 1,
      type: { kind: "float" },
    });
    expect(typed).toBe("---\na: 1 # type:int\nn: 1 # type:float\n---\n");
    expect(applyPlan(typed, { op: "set", key: "n", value: 1, type: null })).toBe(
      "---\na: 1 # type:int\nn: 1\n---\n",
    );
  });

  it("appends a new key after the last pair, before trailing comments", () => {
    const live = "---\na: 1\n# tail\n---\n";
    expect(applyPlan(live, { op: "set", key: "b", value: "" })).toBe(
      '---\na: 1\nb: ""\n# tail\n---\n',
    );
  });

  it("creates a block when the note has no frontmatter", () => {
    expect(applyPlan("body\n", { op: "set", key: "a", value: 1 })).toBe(
      "---\na: 1\n---\nbody\n",
    );
  });

  it("renames a key without touching its value or its type comment", () => {
    const live = "---\nold: 0x1F # type:int\nz: 1\n---\n";
    expect(applyPlan(live, { op: "rename", from: "old", to: "new" })).toBe(
      "---\nnew: 0x1F # type:int\nz: 1\n---\n",
    );
  });

  it("refuses a rename onto an existing key", () => {
    const live = "---\na: 1\nb: 2\n---\n";
    expect(planPropertyEdit(live, { op: "rename", from: "a", to: "b" }, "usd")).toBeNull();
  });

  it("refuses to edit frontmatter it cannot model", () => {
    const live = "---\na: &x 1\nb: *x\n---\n";
    expect(planPropertyEdit(live, { op: "set", key: "a", value: 2 }, "usd")).toBeNull();
  });

  it("preserves CRLF line endings", () => {
    const live = "---\r\na: 1\r\nb: 2\r\n---\r\n";
    expect(applyPlan(live, { op: "set", key: "b", value: [3] })).toBe(
      "---\r\na: 1\r\nb:\r\n  - 3\r\n---\r\n",
    );
  });
});
