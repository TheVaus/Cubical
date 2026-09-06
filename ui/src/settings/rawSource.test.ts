import { describe, expect, it } from "vitest";

import { resolveRawState } from "./rawSource";

describe("resolveRawState", () => {
  it("falls back to the app default when no per-doc override is set", () => {
    expect(resolveRawState(null, false)).toBe(false);
    expect(resolveRawState(null, true)).toBe(true);
  });

  it("honors a per-doc override of true over a false default", () => {
    expect(resolveRawState(true, false)).toBe(true);
  });

  it("honors a per-doc override of false over a true default", () => {
    expect(resolveRawState(false, true)).toBe(false);
  });

  it("opening a fresh file (override reset to null) starts from the default", () => {
    const appDefault = true;
    const previousFileOverride = false;
    expect(resolveRawState(previousFileOverride, appDefault)).toBe(false);
    expect(resolveRawState(null, appDefault)).toBe(appDefault);
  });
});
