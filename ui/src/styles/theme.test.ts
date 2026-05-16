/**
 * Theme resolution — unit tests (L2 Session D, spec §2.5).
 *
 * `resolveTheme` is the pure, DOM-free core of the theme mechanism:
 * given the user's mode (`light`/`dark`/`system`) and the OS
 * dark-mode preference, it returns the concrete theme to apply. The
 * DOM-touching wrappers (`applyTheme`, `watchSystemTheme`) are
 * exercised by the interactive smoke pass, not here — vitest runs in
 * `node` with no `window`.
 */
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
