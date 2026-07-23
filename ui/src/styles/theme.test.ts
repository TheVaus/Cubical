import { describe, expect, it } from "vitest";

import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("resolves system mode to dark when the OS prefers dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("resolves system mode to light when the OS prefers light", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("honors an explicit light mode regardless of OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("honors an explicit dark mode regardless of OS preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
