import { describe, expect, it } from "vitest";
import { padRows, parseDelimited } from "./delimited";

describe("parseDelimited", () => {
  it("splits plain rows and fields", () => {
    expect(parseDelimited("a,b\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("returns no rows for empty input", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });

  it("does not emit a trailing empty row for a trailing newline", () => {
    expect(parseDelimited("a,b\n", ",")).toEqual([["a", "b"]]);
  });

  it("keeps a delimiter inside a quoted field", () => {
    expect(parseDelimited('a,"b,c",d', ",")).toEqual([["a", "b,c", "d"]]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseDelimited('a,"line1\nline2"\nx,y', ",")).toEqual([
      ["a", "line1\nline2"],
      ["x", "y"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseDelimited('"say ""hi""",b', ",")).toEqual([['say "hi"', "b"]]);
  });

  it("preserves empty fields", () => {
    expect(parseDelimited("a,,c", ",")).toEqual([["a", "", "c"]]);
  });

  it("treats CRLF as a single row break", () => {
    expect(parseDelimited("a,b\r\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("treats a bare CR as a row break", () => {
    expect(parseDelimited("a\rb", ",")).toEqual([["a"], ["b"]]);
  });

  it("honours a tab delimiter", () => {
    expect(parseDelimited("a\tb\nc\td", "\t")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not lose the final field when input ends unquoted", () => {
    expect(parseDelimited("a,b", ",")).toEqual([["a", "b"]]);
  });

  it("recovers the trailing field when a quote is never closed", () => {
    expect(parseDelimited('a,"unterminated', ",")).toEqual([
      ["a", "unterminated"],
    ]);
  });

  it("keeps a row of empty fields rather than dropping it", () => {
    expect(parseDelimited(",,", ",")).toEqual([["", "", ""]]);
  });
});

describe("padRows", () => {
  it("pads ragged rows to the widest row", () => {
    expect(padRows([["a"], ["b", "c", "d"], ["e", "f"]])).toEqual([
      ["a", "", ""],
      ["b", "c", "d"],
      ["e", "f", ""],
    ]);
  });

  it("leaves already-rectangular rows untouched", () => {
    const rows = [
      ["a", "b"],
      ["c", "d"],
    ];
    expect(padRows(rows)).toEqual(rows);
  });

  it("handles an empty table", () => {
    expect(padRows([])).toEqual([]);
  });
});
