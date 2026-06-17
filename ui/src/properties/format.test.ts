import { describe, expect, it } from "vitest";

import {
  formatCurrencyUSD,
  normalizeDateTime,
  parseCurrencyInput,
  truncateInt,
} from "./format";

describe("formatCurrencyUSD", () => {
  it("formats as USD with two decimals and separators", () => {
    expect(formatCurrencyUSD(1234.5)).toBe("$1,234.50");
    expect(formatCurrencyUSD(0)).toBe("$0.00");
  });
});

describe("parseCurrencyInput", () => {
  it("strips $ and commas and parses a number", () => {
    expect(parseCurrencyInput("$1,234.50")).toBe(1234.5);
    expect(parseCurrencyInput("9.99")).toBe(9.99);
  });
  it("returns null for non-numeric input", () => {
    expect(parseCurrencyInput("")).toBeNull();
    expect(parseCurrencyInput("abc")).toBeNull();
  });
});

describe("truncateInt", () => {
  it("truncates toward zero", () => {
    expect(truncateInt(3.7)).toBe(3);
    expect(truncateInt(-3.7)).toBe(-3);
    expect(truncateInt(5)).toBe(5);
  });
});

describe("normalizeDateTime", () => {
  it("passes through an ISO datetime", () => {
    expect(normalizeDateTime("2026-06-17T14:30")).toBe("2026-06-17T14:30");
  });
  it("promotes a bare date to midnight", () => {
    expect(normalizeDateTime("2026-06-17")).toBe("2026-06-17T00:00");
  });
  it("returns empty for unparseable input", () => {
    expect(normalizeDateTime("nope")).toBe("");
  });
});
