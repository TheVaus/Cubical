/**
 * Raw-source effective-state resolver — unit tests (L2 Session E,
 * spec §2.3).
 *
 * `resolveRawState` is the pure core of the Raw Source toggle: given
 * the per-doc transient override and the app-level default, it returns
 * whether the editor should show raw markdown. The Solid signals, the
 * `</>` button, and the `Cmd/Ctrl+E` keymap are exercised by the
 * interactive smoke pass — vitest runs in `node` with no editor.
 */
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
    // File-selection change resets the per-doc override to `null`; the
    // effective state then equals the app default, never the previous
    // file's override.
    const appDefault = true;
    const previousFileOverride = false;
    expect(resolveRawState(previousFileOverride, appDefault)).toBe(false);
    // After reset:
    expect(resolveRawState(null, appDefault)).toBe(appDefault);
  });
});
