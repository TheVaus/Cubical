import { describe, expect, it } from "vitest";

import {
  isTypeComment,
  parseTypeComments,
  parseTypeToken,
  type PropertyType,
  typeToToken,
} from "./typeComments";

describe("parseTypeToken", () => {
  it("maps canonical tokens to property types", () => {
    expect(parseTypeToken(" type:text")).toEqual({ kind: "string" });
    expect(parseTypeToken(" type:text/multiline")).toEqual({
      kind: "multiline",
    });
    expect(parseTypeToken(" type:number/int")).toEqual({ kind: "int" });
    expect(parseTypeToken(" type:number/currency")).toEqual({
      kind: "currency",
    });
    expect(parseTypeToken(" type:checkbox")).toEqual({ kind: "boolean" });
    expect(parseTypeToken(" type:datetime")).toEqual({ kind: "datetime" });
    expect(parseTypeToken(" type:list")).toEqual({ kind: "list-of-strings" });
    expect(parseTypeToken(" type:tags")).toEqual({ kind: "list-of-tags" });
  });

  it("parses bare and formatted dates", () => {
    expect(parseTypeToken(" type:date")).toEqual({ kind: "date" });
    expect(parseTypeToken(" type:date:DD-MM-YY")).toEqual({
      kind: "date",
      format: "DD-MM-YY",
    });
    // Unknown date format is still a date; format dropped (falls back later).
    expect(parseTypeToken(" type:date:WUT")).toEqual({ kind: "date" });
  });

  it("accepts aliases and future currency params", () => {
    expect(parseTypeToken("type:date/datetime")).toEqual({ kind: "datetime" });
    expect(parseTypeToken("type:list/tags")).toEqual({ kind: "list-of-tags" });
    expect(parseTypeToken("type:number/currency:EUR")).toEqual({
      kind: "currency",
    });
  });

  it("returns undefined for non-type or unknown kind", () => {
    expect(parseTypeToken("just a note")).toBeUndefined();
    expect(parseTypeToken("type:bogus")).toBeUndefined();
    expect(parseTypeToken(null)).toBeUndefined();
  });
});

describe("isTypeComment", () => {
  it("is true for any recognized type token incl. dates", () => {
    expect(isTypeComment(" type:number/currency")).toBe(true);
    expect(isTypeComment(" type:date:DD-MM-YY")).toBe(true);
    expect(isTypeComment(" type:date:WUT")).toBe(true); // still a date
    expect(isTypeComment(" a regular comment")).toBe(false);
    expect(isTypeComment(" type:nonsense")).toBe(false);
  });
});

describe("typeToToken", () => {
  it("emits canonical tokens; omits default date format", () => {
    expect(typeToToken({ kind: "currency" }, "YYYY-MM-DD")).toBe(
      "number/currency",
    );
    expect(typeToToken({ kind: "date" }, "YYYY-MM-DD")).toBe("date");
    expect(
      typeToToken({ kind: "date", format: "YYYY-MM-DD" }, "YYYY-MM-DD"),
    ).toBe("date");
    expect(
      typeToToken({ kind: "date", format: "DD-MM-YY" }, "YYYY-MM-DD"),
    ).toBe("date:DD-MM-YY");
    expect(typeToToken({ kind: "number" }, "YYYY-MM-DD")).toBeNull();
    expect(typeToToken({ kind: "raw" }, "YYYY-MM-DD")).toBeNull();
  });

  it("round-trips through parseTypeToken", () => {
    const cases: PropertyType[] = [
      { kind: "string" },
      { kind: "multiline" },
      { kind: "int" },
      { kind: "float" },
      { kind: "currency" },
      { kind: "boolean" },
      { kind: "date" },
      { kind: "date", format: "DD-MM-YY" },
      { kind: "datetime" },
      { kind: "list-of-strings" },
      { kind: "list-of-tags" },
    ];
    for (const t of cases) {
      const token = typeToToken(t, "YYYY-MM-DD");
      expect(token).not.toBeNull();
      expect(parseTypeToken(` type:${token}`)).toEqual(t);
    }
  });
});

describe("parseTypeComments", () => {
  it("reads trailing type comments per top-level key", () => {
    const yaml =
      "price: 9.99 # type:number/currency\n" +
      "d: 17-06-26 # type:date:DD-MM-YY\n" +
      "people: # type:list\n  - Ann\n" +
      "plain: hi\n";
    const map = parseTypeComments(yaml);
    expect(map.get("price")).toEqual<PropertyType>({ kind: "currency" });
    expect(map.get("d")).toEqual<PropertyType>({
      kind: "date",
      format: "DD-MM-YY",
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
