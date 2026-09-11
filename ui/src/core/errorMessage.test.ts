import { describe, it, expect } from "vitest";

import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("extracts `.message` from a CubicalError-shaped object", () => {
    expect(errorMessage({ code: "InvalidRequest", message: "bad path" })).toBe(
      "bad path",
    );
  });

  it("extracts `.message` from an Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a primitive that has no message", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });

  it("stringifies null/undefined rather than throwing", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
