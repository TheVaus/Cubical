import { describe, expect, it } from "vitest";

import {
  convertDate,
  DATE_FORMAT_TOKENS,
  DEFAULT_DATE_FORMAT,
  effectiveDateFormat,
  getDateFormat,
  isKnownDateFormat,
  validateDate,
} from "./dateFormats";

describe("table", () => {
  it("default is ISO and all tokens are known", () => {
    expect(DEFAULT_DATE_FORMAT).toBe("YYYY-MM-DD");
    for (const t of DATE_FORMAT_TOKENS) expect(isKnownDateFormat(t)).toBe(true);
    expect(isKnownDateFormat("MMM D")).toBe(false);
  });
  it("marks YYYY-MM-DD native and YYYY numeric", () => {
    expect(getDateFormat("YYYY-MM-DD")!.native).toBe(true);
    expect(getDateFormat("YYYY")!.numeric).toBe(true);
    expect(getDateFormat("DD-MM-YY")!.native).toBe(false);
  });
});

describe("validateDate", () => {
  it("accepts well-formed, rejects malformed", () => {
    expect(validateDate("2026-06-17", "YYYY-MM-DD")).toBe(true);
    expect(validateDate("17-06-26", "DD-MM-YY")).toBe(true);
    expect(validateDate(2026, "YYYY")).toBe(true);
    expect(validateDate("2026/06", "YYYY-MM")).toBe(false);
    expect(validateDate("nope", "YYYY-MM-DD")).toBe(false);
  });
});

describe("convertDate", () => {
  it("reformats between formats that share parts", () => {
    expect(convertDate("2026-06-17", "DD-MM-YYYY")).toEqual({
      value: "17-06-2026",
      lossy: false,
    });
    expect(convertDate("17/06/2026", "YYYY-MM-DD")).toEqual({
      value: "2026-06-17",
      lossy: false,
    });
    expect(convertDate("2026-06-17", "YYYY")).toEqual({
      value: 2026,
      lossy: false,
    });
  });
  it("blanks + flags lossy when widening loses month/day", () => {
    expect(convertDate(2026, "YYYY-MM-DD")).toEqual({ value: "", lossy: true });
  });
  it("blanks + flags lossy for unparseable input", () => {
    expect(convertDate("garbage", "YYYY-MM-DD")).toEqual({
      value: "",
      lossy: true,
    });
  });
});

describe("effectiveDateFormat", () => {
  it("prefers inline, then vault default, then ISO", () => {
    expect(effectiveDateFormat("DD-MM-YY", "YYYY")).toBe("DD-MM-YY");
    expect(effectiveDateFormat(undefined, "YYYY")).toBe("YYYY");
    expect(effectiveDateFormat(undefined, undefined)).toBe("YYYY-MM-DD");
    expect(effectiveDateFormat("BOGUS", "ALSO-BAD")).toBe("YYYY-MM-DD");
  });
});
