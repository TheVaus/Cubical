import { describe, expect, it } from "vitest";

import { evaluate, type RefResolution } from "./evaluate";

const num = (src: string) => evaluate(src, () => ({ kind: "not_a_number" }));

describe("evaluate — arithmetic", () => {
  it("subtracts two numbers", () => {
    expect(num("5-3")).toEqual({ status: "ok", value: 2 });
  });

  it("applies multiplication before addition", () => {
    expect(num("2 + 3 * 4")).toEqual({ status: "ok", value: 14 });
  });

  it("honours parentheses over precedence", () => {
    expect(num("(2 + 3) * 4")).toEqual({ status: "ok", value: 20 });
  });

  it("applies unary minus to a parenthesised group", () => {
    expect(num("-(2 + 3)")).toEqual({ status: "ok", value: -5 });
  });

  it("evaluates division and remainder left to right", () => {
    expect(num("20 / 4 % 3")).toEqual({ status: "ok", value: 2 });
  });

  it("reads decimal literals", () => {
    expect(num("1.5 * 2")).toEqual({ status: "ok", value: 3 });
  });
});

describe("evaluate — property refs", () => {
  const age = (): RefResolution => ({ kind: "number", value: 5 });

  it("uses a cross-note ref as an operand", () => {
    expect(evaluate("[[file-name.age]]-3", age)).toEqual({
      status: "ok",
      value: 2,
    });
  });

  it("uses a same-note ref as an operand", () => {
    expect(evaluate("[[.age]] - 3", age)).toEqual({ status: "ok", value: 2 });
  });

  it("passes the note and property to the resolver", () => {
    const seen: Array<[string | null, string]> = [];
    evaluate("[[dan.age]] + [[.height]]", (note, property) => {
      seen.push([note, property]);
      return { kind: "number", value: 1 };
    });
    expect(seen).toEqual([
      ["dan", "age"],
      [null, "height"],
    ]);
  });

  it("reports loading while any operand is still resolving", () => {
    expect(evaluate("[[dan.age]] - 3", () => ({ kind: "loading" }))).toEqual({
      status: "loading",
    });
  });
});

describe("evaluate — errors", () => {
  const unusable = (kind: RefResolution["kind"]) => () => ({ kind }) as RefResolution;

  it("reports a syntax error for a dangling operator", () => {
    expect(num("5 +")).toEqual({ status: "error", kind: "syntax" });
  });

  it("reports a syntax error for unbalanced parentheses", () => {
    expect(num("(5 + 3")).toEqual({ status: "error", kind: "syntax" });
  });

  it("reports a syntax error for prose", () => {
    expect(num("SUM(A1:B2)")).toEqual({ status: "error", kind: "syntax" });
  });

  it("reports divide_by_zero rather than Infinity", () => {
    expect(num("5 / 0")).toEqual({ status: "error", kind: "divide_by_zero" });
  });

  it("reports not_a_number when the property is not numeric", () => {
    expect(evaluate("[[.age]] - 3", unusable("not_a_number"))).toEqual({
      status: "error",
      kind: "not_a_number",
    });
  });

  it("reports unresolved_note when the note does not exist", () => {
    expect(evaluate("[[ghost.age]] - 3", unusable("unresolved_note"))).toEqual({
      status: "error",
      kind: "unresolved_note",
    });
  });

  it("reports missing_property when the note lacks the key", () => {
    expect(evaluate("[[dan.ghost]] - 3", unusable("missing_property"))).toEqual({
      status: "error",
      kind: "missing_property",
    });
  });
});

describe("evaluate — totality", () => {
  it("refuses a source longer than the cap instead of evaluating it", () => {
    const long = `1${" + 1".repeat(1000)}`;
    expect(num(long)).toEqual({ status: "error", kind: "too_complex" });
  });

  it("refuses more tokens than the cap", () => {
    const many = `1${" + 1".repeat(200)}`;
    expect(num(many)).toEqual({ status: "error", kind: "too_complex" });
  });

  it("evaluates nesting that fits inside the token cap", () => {
    const nested = `${"(".repeat(120)}1${")".repeat(120)}`;
    expect(num(nested)).toEqual({ status: "ok", value: 1 });
  });

  it("refuses nesting past the token cap rather than recursing into it", () => {
    const nested = `${"(".repeat(400)}1${")".repeat(400)}`;
    expect(num(nested)).toEqual({ status: "error", kind: "too_complex" });
  });
});
