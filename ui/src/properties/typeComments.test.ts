import { describe, expect, it } from "vitest";

import {
  isTypeComment,
  parseTypeComments,
  parseTypeToken,
  type PropertyType,
  typeToToken,
} from "./typeComments";

const ISO = "YYYY-MM-DD";

describe("parseTypeToken", () => {
  it("maps canonical tokens to property types", () => {
    expect(parseTypeToken(" type:text")).toEqual({ kind: "string" });
    expect(parseTypeToken(" type:int")).toEqual({ kind: "int" });
    expect(parseTypeToken(" type:float")).toEqual({ kind: "float" });
    expect(parseTypeToken(" type:boolean")).toEqual({ kind: "boolean" });
    expect(parseTypeToken(" type:list")).toEqual({ kind: "list-of-strings" });
  });

  it("parses currency with a code", () => {
    expect(parseTypeToken(" type:float/currency/usd")).toEqual({
      kind: "currency",
      currency: "usd",
    });
    expect(parseTypeToken(" type:float/currency/NIS")).toEqual({
      kind: "currency",
      currency: "nis",
    });
  });

  it("parses enum value sets (numbers stay tokens here)", () => {
    expect(parseTypeToken(" type:enum(alive,dead)")).toEqual({
      kind: "enum",
      values: ["alive", "dead"],
    });
    expect(parseTypeToken(" type:enum(1, 0)")).toEqual({
      kind: "enum",
      values: ["1", "0"],
    });
    expect(parseTypeToken(" type:enum()")).toEqual({ kind: "enum", values: [] });
  });

  it("parses bare and formatted dates incl. spaces", () => {
    expect(parseTypeToken(" type:date")).toEqual({ kind: "date" });
    expect(parseTypeToken(" type:date:DD-MM-YY")).toEqual({
      kind: "date",
      format: "DD-MM-YY",
    });
    expect(parseTypeToken(" type:date:YYYY-MM-DD HH:MM")).toEqual({
      kind: "date",
      format: "YYYY-MM-DD HH:MM",
    });
    // Unknown date format is still a date; format dropped.
    expect(parseTypeToken(" type:date:WUT")).toEqual({ kind: "date" });
  });

  it("returns undefined for non-type or unknown kind", () => {
    expect(parseTypeToken("just a note")).toBeUndefined();
    expect(parseTypeToken("type:bogus")).toBeUndefined();
    expect(parseTypeToken("type:number")).toBeUndefined();
    expect(parseTypeToken(null)).toBeUndefined();
  });
});

describe("isTypeComment", () => {
  it("is true for any recognized type token", () => {
    expect(isTypeComment(" type:float/currency/eur")).toBe(true);
    expect(isTypeComment(" type:enum(a,b)")).toBe(true);
    expect(isTypeComment(" type:date:YYYY-MM-DD HH:MM")).toBe(true);
    expect(isTypeComment(" a regular comment")).toBe(false);
    expect(isTypeComment(" type:nonsense")).toBe(false);
  });
});

describe("typeToToken", () => {
  it("emits canonical tokens; omits default date format", () => {
    expect(typeToToken({ kind: "currency", currency: "nis" }, ISO)).toBe(
      "float/currency/nis",
    );
    expect(typeToToken({ kind: "enum", values: ["a", "b"] }, ISO)).toBe(
      "enum(a,b)",
    );
    expect(typeToToken({ kind: "date" }, ISO)).toBe("date");
    expect(typeToToken({ kind: "date", format: ISO }, ISO)).toBe("date");
    expect(typeToToken({ kind: "date", format: "DD-MM-YY" }, ISO)).toBe(
      "date:DD-MM-YY",
    );
    expect(typeToToken({ kind: "raw" }, ISO)).toBeNull();
  });

  it("round-trips through parseTypeToken", () => {
    const cases: PropertyType[] = [
      { kind: "string" },
      { kind: "int" },
      { kind: "float" },
      { kind: "currency", currency: "usd" },
      { kind: "boolean" },
      { kind: "enum", values: ["alive", "dead"] },
      { kind: "date" },
      { kind: "date", format: "DD-MM-YY" },
      { kind: "date", format: "YYYY-MM-DD HH:MM" },
      { kind: "list-of-strings" },
    ];
    for (const t of cases) {
      const token = typeToToken(t, ISO);
      expect(token).not.toBeNull();
      expect(parseTypeToken(` type:${token}`)).toEqual(t);
    }
  });
});

describe("parseTypeComments", () => {
  it("reads trailing type comments per top-level key", () => {
    const yaml =
      "price: 9.99 # type:float/currency/usd\n" +
      "status: alive # type:enum(alive,dead)\n" +
      "people: # type:list\n  - Ann\n" +
      "plain: hi\n";
    const map = parseTypeComments(yaml);
    expect(map.get("price")).toEqual<PropertyType>({
      kind: "currency",
      currency: "usd",
    });
    expect(map.get("status")).toEqual<PropertyType>({
      kind: "enum",
      values: ["alive", "dead"],
    });
    expect(map.get("people")).toEqual<PropertyType>({
      kind: "list-of-strings",
    });
    expect(map.has("plain")).toBe(false);
  });

  it("ignores unknown comments and malformed yaml", () => {
    expect(parseTypeComments("a: 1 # whatever\n").size).toBe(0);
    expect(parseTypeComments("a: : :\n  - bad\n").size).toBe(0);
  });
});
