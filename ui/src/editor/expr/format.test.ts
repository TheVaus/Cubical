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

  it("trims the trailing noise of a decimal product", () => {
    expect(formatResult(2.675 * 100)).toBe("267.5");
  });

  it("keeps a small addend that is a real value, not noise", () => {
    expect(formatResult(1.5000000001e-11 + 3)).toBe("3.00000000002");
  });

  it("renders a negative result", () => {
    expect(formatResult(-5)).toBe("-5");
  });

  it("renders large values without exponent notation", () => {
    expect(formatResult(1200 * 1.2)).toBe("1440");
  });
})

describe("formatResult — precision", () => {
  it("keeps a small magnitude instead of collapsing it to zero", () => {
    expect(formatResult(0.0000000001 / 3)).not.toBe("0");
  });

  it("keeps twelve significant digits of a repeating fraction", () => {
    expect(formatResult(1 / 3)).toBe("0.333333333333");
  });

  it("does not invent precision beyond the rounding point", () => {
    expect(formatResult(2 / 3)).toBe("0.666666666667");
  });
});
