import { describe, expect, it } from "vitest";

import { formatResult } from "./format";

describe("formatResult", () => {
  it("renders an integer without a decimal point", () => {
    expect(formatResult(2)).toBe("2");
  });

  it("hides binary floating-point noise", () => {
    expect(formatResult(0.1 + 0.2)).toBe("0.3");
  });

  it("keeps a genuine fractional part", () => {
    expect(formatResult(12.67)).toBe("12.67");
  });

  it("trims trailing zeros", () => {
    expect(formatResult(1.5000000001e-11 + 3)).toBe("3");
  });

  it("renders a negative result", () => {
    expect(formatResult(-5)).toBe("-5");
  });

  it("renders large values without exponent notation", () => {
    expect(formatResult(1200 * 1.2)).toBe("1440");
  });
})
