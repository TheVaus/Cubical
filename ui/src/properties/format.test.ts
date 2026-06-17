import { describe, expect, it } from "vitest";

import {
  formatCurrency,
  isKnownCurrency,
  parseCurrencyInput,
  truncateInt,
} from "./format";

describe("formatCurrency", () => {
  it("formats known currencies with their symbol", () => {
    expect(formatCurrency(1234.5, "usd")).toBe("$1,234.50");
    expect(formatCurrency(1234.5, "eur")).toBe("€1,234.50");
    expect(formatCurrency(1234.5, "nis")).toBe("₪1,234.50");
  });
  it("falls back to a plain number for an unknown code", () => {
    expect(formatCurrency(1234.5, "xyz")).toBe("1,234.5");
  });
});

describe("isKnownCurrency", () => {
  it("recognizes supported codes", () => {
    expect(isKnownCurrency("usd")).toBe(true);
    expect(isKnownCurrency("nis")).toBe(true);
    expect(isKnownCurrency("eur")).toBe(true);
    expect(isKnownCurrency("gbp")).toBe(false);
  });
});

describe("parseCurrencyInput", () => {
  it("strips symbols and commas and parses a number", () => {
    expect(parseCurrencyInput("$1,234.50")).toBe(1234.5);
    expect(parseCurrencyInput("₪9.99")).toBe(9.99);
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
